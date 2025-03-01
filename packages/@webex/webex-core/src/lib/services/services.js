import sha256 from 'crypto-js/sha256';

import {union, forEach} from 'lodash';
import WebexPlugin from '../webex-plugin';

import METRICS from './metrics';
import ServiceCatalog from './service-catalog';
import ServiceRegistry from './service-registry';
import ServiceState from './service-state';
import fedRampServices from './service-fed-ramp';
import {COMMERCIAL_ALLOWED_DOMAINS} from './constants';

const trailingSlashes = /(?:^\/)|(?:\/$)/;

// The default cluster when one is not provided (usually as 'US' from hydra)
export const DEFAULT_CLUSTER = 'urn:TEAM:us-east-2_a';
// The default service name for convo (currently identityLookup due to some weird CSB issue)
export const DEFAULT_CLUSTER_SERVICE = 'identityLookup';

const CLUSTER_SERVICE = process.env.WEBEX_CONVERSATION_CLUSTER_SERVICE || DEFAULT_CLUSTER_SERVICE;
const DEFAULT_CLUSTER_IDENTIFIER =
  process.env.WEBEX_CONVERSATION_DEFAULT_CLUSTER || `${DEFAULT_CLUSTER}:${CLUSTER_SERVICE}`;

/* eslint-disable no-underscore-dangle */
/**
 * @class
 */
const Services = WebexPlugin.extend({
  namespace: 'Services',

  /**
   * The {@link WeakMap} of {@link ServiceRegistry} class instances that are
   * keyed with WebexCore instances.
   *
   * @instance
   * @type {WeakMap<WebexCore, ServiceRegistry>}
   * @private
   * @memberof Services
   */
  registries: new WeakMap(),

  /**
   * The {@link WeakMap} of {@link ServiceState} class instances that are
   * keyed with WebexCore instances.
   *
   * @instance
   * @type {WeakMap<WebexCore, ServiceState>}
   * @private
   * @memberof Services
   */
  states: new WeakMap(),

  props: {
    validateDomains: ['boolean', false, true],
    initFailed: ['boolean', false, false],
  },

  _catalogs: new WeakMap(),

  _serviceUrls: null,

  _hostCatalog: null,

  /**
   * Get the registry associated with this webex instance.
   *
   * @private
   * @memberof Services
   * @returns {ServiceRegistry} - The associated {@link ServiceRegistry}.
   */
  getRegistry() {
    return this.registries.get(this.webex);
  },

  /**
   * Get the state associated with this webex instance.
   *
   * @private
   * @memberof Services
   * @returns {ServiceState} - The associated {@link ServiceState}.
   */
  getState() {
    return this.states.get(this.webex);
  },

  /**
   * @private
   * Get the current catalog based on the assocaited
   * webex instance.
   * @returns {ServiceCatalog}
   */
  _getCatalog() {
    return this._catalogs.get(this.webex);
  },

  /**
   * Get a service url from the current services list by name
   * from the associated instance catalog.
   * @param {string} name
   * @param {boolean} [priorityHost]
   * @param {string} [serviceGroup]
   * @returns {string|undefined}
   */
  get(name, priorityHost, serviceGroup) {
    const catalog = this._getCatalog();

    return catalog.get(name, priorityHost, serviceGroup);
  },

  /**
   * Determine if the catalog contains a specific service
   *
   * @param {string} serviceName - The service name to validate.
   * @returns {boolean} - True if the service exists.
   */
  hasService(serviceName) {
    return !!this.get(serviceName);
  },

  /**
   * Determine if a whilelist exists in the service catalog.
   *
   * @returns {boolean} - True if a allowed domains list exists.
   */
  hasAllowedDomains() {
    const catalog = this._getCatalog();

    return catalog.getAllowedDomains().length > 0;
  },

  /**
   * Generate a service catalog as an object from
   * the associated instance catalog.
   * @param {boolean} [priorityHost] - use highest priority host if set to `true`
   * @param {string} [serviceGroup]
   * @returns {Record<string, string>}
   */
  list(priorityHost, serviceGroup) {
    const catalog = this._getCatalog();

    return catalog.list(priorityHost, serviceGroup);
  },

  /**
   * Mark a priority host service url as failed.
   * This will mark the host associated with the
   * `ServiceUrl` to be removed from the its
   * respective host array, and then return the next
   * viable host from the `ServiceUrls` host array,
   * or the `ServiceUrls` default url if no other priority
   * hosts are available, or if `noPriorityHosts` is set to
   * `true`.
   * @param {string} url
   * @param {boolean} noPriorityHosts
   * @returns {string}
   */
  markFailedUrl(url, noPriorityHosts) {
    const catalog = this._getCatalog();

    return catalog.markFailedUrl(url, noPriorityHosts);
  },

  /**
   * saves all the services from the pre and post catalog service
   * @param {Object} serviceUrls
   * @returns {void}
   */
  _updateServiceUrls(serviceUrls) {
    this._serviceUrls = {...this._serviceUrls, ...serviceUrls};
  },

  /**
   * saves the hostCatalog object
   * @param {Object} hostCatalog
   * @returns {void}
   */
  _updateHostCatalog(hostCatalog) {
    this._hostCatalog = {...this._hostCatalog, ...hostCatalog};
  },

  /**
   * Update a list of `serviceUrls` to the most current
   * catalog via the defined `discoveryUrl` then returns the current
   * list of services.
   * @param {object} [param]
   * @param {string} [param.from] - This accepts `limited` or `signin`
   * @param {object} [param.query] - This accepts `email`, `orgId` or `userId` key values
   * @param {string} [param.query.email] - must be a standard-format email
   * @param {string} [param.query.orgId] - must be an organization id
   * @param {string} [param.query.userId] - must be a user id
   * @param {string} [param.token] - used for signin catalog
   * @returns {Promise<object>}
   */
  updateServices({from, query, token, forceRefresh} = {}) {
    const catalog = this._getCatalog();
    let formattedQuery;
    let serviceGroup;

    // map catalog name to service group name.
    switch (from) {
      case 'limited':
        serviceGroup = 'preauth';
        break;
      case 'signin':
        serviceGroup = 'signin';
        break;
      default:
        serviceGroup = 'postauth';
        break;
    }

    // confirm catalog update for group is not in progress.
    if (catalog.status[serviceGroup].collecting) {
      return this.waitForCatalog(serviceGroup);
    }

    catalog.status[serviceGroup].collecting = true;

    if (serviceGroup === 'preauth') {
      const queryKey = query && Object.keys(query)[0];

      if (!['email', 'emailhash', 'userId', 'orgId', 'mode'].includes(queryKey)) {
        return Promise.reject(
          new Error('a query param of email, emailhash, userId, orgId, or mode is required')
        );
      }
    }
    // encode email when query key is email
    if (serviceGroup === 'preauth' || serviceGroup === 'signin') {
      const queryKey = Object.keys(query)[0];

      formattedQuery = {};

      if (queryKey === 'email' && query.email) {
        formattedQuery.emailhash = sha256(query.email.toLowerCase()).toString();
      } else {
        formattedQuery[queryKey] = query[queryKey];
      }
    }

    return this._fetchNewServiceHostmap({
      from,
      token,
      query: formattedQuery,
      forceRefresh,
    })
      .then((serviceHostMap) => {
        catalog.updateServiceUrls(serviceGroup, serviceHostMap);
        this.updateCredentialsConfig();
        catalog.status[serviceGroup].collecting = false;
      })
      .catch((error) => {
        catalog.status[serviceGroup].collecting = false;

        return Promise.reject(error);
      });
  },

  /**
   * User validation parameter transfer object for {@link validateUser}.
   * @param {object} ValidateUserPTO
   * @property {string} ValidateUserPTO.email - The email of the user.
   * @property {string} [ValidateUserPTO.reqId] - The activation requester.
   * @property {object} [ValidateUserPTO.activationOptions] - Extra options to pass when sending the activation
   * @property {object} [ValidateUserPTO.preloginUserId] - The prelogin user id to set when sending the activation.
   */

  /**
   * User validation return transfer object for {@link validateUser}.
   * @param {object} ValidateUserRTO
   * @property {boolean} ValidateUserRTO.activated - If the user is activated.
   * @property {boolean} ValidateUserRTO.exists - If the user exists.
   * @property {string} ValidateUserRTO.details - A descriptive status message.
   * @property {object} ValidateUserRTO.user - **License** service user object.
   */

  /**
   * Validate if a user is activated and update the service catalogs as needed
   * based on the user's activation status.
   *
   * @param {ValidateUserPTO} - The parameter transfer object.
   * @returns {ValidateUserRTO} - The return transfer object.
   */
  validateUser({
    email,
    reqId = 'WEBCLIENT',
    forceRefresh = false,
    activationOptions = {},
    preloginUserId,
  }) {
    this.logger.info('services: validating a user');

    // Validate that an email parameter key was provided.
    if (!email) {
      return Promise.reject(new Error('`email` is required'));
    }

    // Destructure the credentials object.
    const {canAuthorize} = this.webex.credentials;

    // Validate that the user is already authorized.
    if (canAuthorize) {
      return this.updateServices({forceRefresh})
        .then(() => this.webex.credentials.getUserToken())
        .then((token) =>
          this.sendUserActivation({
            email,
            reqId,
            token: token.toString(),
            activationOptions,
            preloginUserId,
          })
        )
        .then((userObj) => ({
          activated: true,
          exists: true,
          details: 'user is authorized via a user token',
          user: userObj,
        }));
    }

    // Destructure the client authorization details.
    /* eslint-disable camelcase */
    const {client_id, client_secret} = this.webex.credentials.config;

    // Validate that client authentication details exist.
    if (!client_id || !client_secret) {
      return Promise.reject(new Error('client authentication details are not available'));
    }
    /* eslint-enable camelcase */

    // Declare a class-memeber-scoped token for usage within the promise chain.
    let token;

    // Begin client authentication user validation.
    return (
      this.collectPreauthCatalog({email})
        .then(() => {
          // Retrieve the service url from the updated catalog. This is required
          // since `WebexCore` is usually not fully initialized at the time this
          // request completes.
          const idbrokerService = this.get('idbroker', true);

          // Collect the client auth token.
          return this.webex.credentials.getClientToken({
            uri: `${idbrokerService}idb/oauth2/v1/access_token`,
            scope: 'webexsquare:admin webexsquare:get_conversation Identity:SCIM',
          });
        })
        .then((tokenObj) => {
          // Generate the token string.
          token = tokenObj.toString();

          // Collect the signin catalog using the client auth information.
          return this.collectSigninCatalog({email, token, forceRefresh});
        })
        // Validate if collecting the signin catalog failed and populate the RTO
        // with the appropriate content.
        .catch((error) => ({
          exists: error.name !== 'NotFound',
          activated: false,
          details:
            error.name !== 'NotFound'
              ? 'user exists but is not activated'
              : 'user does not exist and is not activated',
        }))
        // Validate if the previous promise resolved with an RTO and populate the
        // new RTO accordingly.
        .then((rto) =>
          Promise.all([
            rto || {
              activated: true,
              exists: true,
              details: 'user exists and is activated',
            },
            this.sendUserActivation({
              email,
              reqId,
              token,
              activationOptions,
              preloginUserId,
            }),
          ])
        )
        .then(([rto, user]) => ({...rto, user}))
        .catch((error) => {
          const response = {
            statusCode: error.statusCode,
            responseText: error.body && error.body.message,
            body: error.body,
          };

          return Promise.reject(response);
        })
    );
  },

  /**
   * Get user meeting preferences (preferred webex site).
   *
   * @returns {object} - User Information including user preferrences .
   */
  getMeetingPreferences() {
    return this.request({
      method: 'GET',
      service: 'hydra',
      resource: 'meetingPreferences',
    })
      .then((res) => {
        this.logger.info('services: received user region info');

        return res.body;
      })
      .catch((err) => {
        this.logger.info('services: was not able to fetch user login information', err);
        // resolve successfully even if request failed
      });
  },

  /**
   * Fetches client region info such as countryCode and timezone.
   *
   * @returns {object} - The region info object.
   */
  fetchClientRegionInfo() {
    const {services} = this.webex.config;

    return this.request({
      uri: services.discovery.sqdiscovery,
      addAuthHeader: false,
      headers: {
        'spark-user-agent': null,
      },
      timeout: 5000,
    })
      .then((res) => {
        this.logger.info('services: received user region info');

        return res.body;
      })
      .catch((err) => {
        this.logger.info('services: was not able to get user region info', err);
        // resolve successfully even if request failed
      });
  },

  /**
   * User activation parameter transfer object for {@link sendUserActivation}.
   * @typedef {object} SendUserActivationPTO
   * @property {string} SendUserActivationPTO.email - The email of the user.
   * @property {string} SendUserActivationPTO.reqId - The activation requester.
   * @property {string} SendUserActivationPTO.token - The client auth token.
   * @property {object} SendUserActivationPTO.activationOptions - Extra options to pass when sending the activation.
   * @property {object} SendUserActivationPTO.preloginUserId - The prelogin user id to set when sending the activation.
   */

  /**
   * Send a request to activate a user using a client token.
   *
   * @param {SendUserActivationPTO} - The Parameter transfer object.
   * @returns {LicenseDTO} - The DTO returned from the **License** service.
   */
  sendUserActivation({email, reqId, token, activationOptions, preloginUserId}) {
    this.logger.info('services: sending user activation request');
    let countryCode;
    let timezone;

    // try to fetch client region info first
    return (
      this.fetchClientRegionInfo()
        .then((clientRegionInfo) => {
          if (clientRegionInfo) {
            ({countryCode, timezone} = clientRegionInfo);
          }

          // Send the user activation request to the **License** service.
          return this.request({
            service: 'license',
            resource: 'users/activations',
            method: 'POST',
            headers: {
              accept: 'application/json',
              authorization: token,
              'x-prelogin-userid': preloginUserId,
            },
            body: {
              email,
              reqId,
              countryCode,
              timeZone: timezone,
              ...activationOptions,
            },
            shouldRefreshAccessToken: false,
          });
        })
        // On success, return the **License** user object.
        .then(({body}) => body)
        // On failure, reject with error from **License**.
        .catch((error) => Promise.reject(error))
    );
  },

  /**
   * Updates a given service group i.e. preauth, signin, postauth with a new hostmap.
   * @param {string} serviceGroup - preauth, signin, postauth
   * @param {object} hostMap - The new hostmap to update the service group with.
   * @returns {Promise<void>}
   */
  updateCatalog(serviceGroup, hostMap) {
    const catalog = this._getCatalog();

    const serviceHostMap = this._formatReceivedHostmap(hostMap);

    return catalog.updateServiceUrls(serviceGroup, serviceHostMap);
  },

  /**
   * simplified method to update the preauth catalog via email
   *
   * @param {object} query
   * @param {string} query.email - A standard format email.
   * @param {string} query.orgId - The user's OrgId.
   * @param {boolean} forceRefresh - Boolean to bypass u2c cache control header
   * @returns {Promise<void>}
   */
  collectPreauthCatalog(query, forceRefresh = false) {
    if (!query) {
      return this.updateServices({
        from: 'limited',
        query: {mode: 'DEFAULT_BY_PROXIMITY'},
        forceRefresh,
      });
    }

    return this.updateServices({from: 'limited', query, forceRefresh});
  },

  /**
   * simplified method to update the signin catalog via email and token
   * @param {object} param
   * @param {string} param.email - must be a standard-format email
   * @param {string} param.token - must be a client token
   * @returns {Promise<void>}
   */
  collectSigninCatalog({email, token, forceRefresh} = {}) {
    if (!email) {
      return Promise.reject(new Error('`email` is required'));
    }
    if (!token) {
      return Promise.reject(new Error('`token` is required'));
    }

    return this.updateServices({
      from: 'signin',
      query: {email},
      token,
      forceRefresh,
    });
  },

  /**
   * Updates credentials config to utilize u2c catalog
   * urls.
   * @returns {void}
   */
  updateCredentialsConfig() {
    const {idbroker, identity} = this.list(true);

    if (idbroker && identity) {
      const {authorizationString, authorizeUrl} = this.webex.config.credentials;

      // This must be set outside of the setConfig method used to assign the
      // idbroker and identity url values.
      this.webex.config.credentials.authorizeUrl = authorizationString
        ? authorizeUrl
        : `${idbroker.replace(trailingSlashes, '')}/idb/oauth2/v1/authorize`;

      this.webex.setConfig({
        credentials: {
          idbroker: {
            url: idbroker.replace(trailingSlashes, ''), // remove trailing slash
          },
          identity: {
            url: identity.replace(trailingSlashes, ''), // remove trailing slash
          },
        },
      });
    }
  },

  /**
   * Wait until the service catalog is available,
   * or reject afte ra timeout of 60 seconds.
   * @param {string} serviceGroup
   * @param {number} [timeout] - in seconds
   * @returns {Promise<void>}
   */
  waitForCatalog(serviceGroup, timeout) {
    const catalog = this._getCatalog();
    const {supertoken} = this.webex.credentials;

    if (
      serviceGroup === 'postauth' &&
      supertoken &&
      supertoken.access_token &&
      !catalog.status.postauth.collecting &&
      !catalog.status.postauth.ready
    ) {
      if (!catalog.status.preauth.ready) {
        return this.initServiceCatalogs();
      }

      return this.updateServices();
    }

    return catalog.waitForCatalog(serviceGroup, timeout);
  },

  /**
   * Service waiting parameter transfer object for {@link waitForService}.
   *
   * @typedef {object} WaitForServicePTO
   * @property {string} [WaitForServicePTO.name] - The service name.
   * @property {string} [WaitForServicePTO.url] - The service url.
   * @property {string} [WaitForServicePTO.timeout] - wait duration in seconds.
   */

  /**
   * Wait until the service has been ammended to any service catalog. This
   * method prioritizes the service name over the service url when searching.
   *
   * @param {WaitForServicePTO} - The parameter transfer object.
   * @returns {Promise<string>} - Resolves to the priority host of a service.
   */
  waitForService({name, timeout = 5, url}) {
    const {services} = this.webex.config;

    // Save memory by grabbing the catalog after there isn't a priortyURL
    const catalog = this._getCatalog();

    const fetchFromServiceUrl = services.servicesNotNeedValidation.find(
      (service) => service === name
    );

    if (fetchFromServiceUrl) {
      return Promise.resolve(this._serviceUrls[name]);
    }

    const priorityUrl = this.get(name, true);
    const priorityUrlObj = this.getServiceFromUrl(url);

    if (priorityUrl || priorityUrlObj) {
      return Promise.resolve(priorityUrl || priorityUrlObj.priorityUrl);
    }

    if (catalog.isReady) {
      if (url) {
        return Promise.resolve(url);
      }

      this.webex.internal.metrics.submitClientMetrics(METRICS.JS_SDK_SERVICE_NOT_FOUND, {
        fields: {service_name: name},
      });

      return Promise.reject(
        new Error(`services: service '${name}' was not found in any of the catalogs`)
      );
    }

    return new Promise((resolve, reject) => {
      const groupsToCheck = ['preauth', 'signin', 'postauth'];
      const checkCatalog = (catalogGroup) =>
        catalog
          .waitForCatalog(catalogGroup, timeout)
          .then(() => {
            const scopedPriorityUrl = this.get(name, true);
            const scopedPrioriryUrlObj = this.getServiceFromUrl(url);

            if (scopedPriorityUrl || scopedPrioriryUrlObj) {
              resolve(scopedPriorityUrl || scopedPrioriryUrlObj.priorityUrl);
            }
          })
          .catch(() => undefined);

      Promise.all(groupsToCheck.map((group) => checkCatalog(group))).then(() => {
        this.webex.internal.metrics.submitClientMetrics(METRICS.JS_SDK_SERVICE_NOT_FOUND, {
          fields: {service_name: name},
        });
        reject(new Error(`services: service '${name}' was not found after waiting`));
      });
    });
  },

  /**
   * Looks up the hostname in the host catalog
   * and replaces it with the first host if it finds it
   * @param {string} uri
   * @returns {string} uri with the host replaced
   */
  replaceHostFromHostmap(uri) {
    const url = new URL(uri);
    const hostCatalog = this._hostCatalog;

    if (!hostCatalog) {
      return uri;
    }

    const host = hostCatalog[url.host];

    if (host && host[0]) {
      const newHost = host[0].host;

      url.host = newHost;

      return url.toString();
    }

    return uri;
  },

  /**
   * @private
   * Organize a received hostmap from a service
   * catalog endpoint.
   * @param {object} serviceHostmap
   * @returns {object}
   */
  _formatReceivedHostmap(serviceHostmap) {
    this._updateHostCatalog(serviceHostmap.hostCatalog);

    const extractId = (entry) => entry.id.split(':')[3];

    const formattedHostmap = [];

    // for each of the services in the serviceLinks, find the matching host in the catalog
    Object.keys(serviceHostmap.serviceLinks).forEach((serviceName) => {
      const serviceUrl = serviceHostmap.serviceLinks[serviceName];

      let host;
      try {
        host = new URL(serviceUrl).host;
      } catch (e) {
        return;
      }

      const matchingCatalogEntry = serviceHostmap.hostCatalog[host];

      const formattedHost = {
        name: serviceName,
        defaultUrl: serviceUrl,
        defaultHost: host,
        hosts: [],
      };

      formattedHostmap.push(formattedHost);

      // If the catalog does not have any hosts we will be unable to find the service ID
      // so can't search for other hosts
      if (!matchingCatalogEntry || !matchingCatalogEntry[0]) {
        return;
      }

      const serviceId = extractId(matchingCatalogEntry[0]);

      forEach(matchingCatalogEntry, (entry) => {
        // The ids for all hosts within a hostCatalog entry should be the same
        // but for safety, only add host entries that have the same id as the first one
        if (extractId(entry) === serviceId) {
          formattedHost.hosts.push({
            ...entry,
            homeCluster: true,
          });
        }
      });

      const otherHosts = [];

      // find the services in the host catalog that have the same id
      // and add them to the otherHosts
      forEach(serviceHostmap.hostCatalog, (entry) => {
        // exclude the matching catalog entry as we have already added that
        if (entry === matchingCatalogEntry) {
          return;
        }

        forEach(entry, (entryHost) => {
          // only add hosts that have the correct id
          if (extractId(entryHost) === serviceId) {
            otherHosts.push({
              ...entryHost,
              homeCluster: false,
            });
          }
        });
      });

      formattedHost.hosts.push(...otherHosts);
    });

    // update all the service urls in the host catalog

    this._updateServiceUrls(serviceHostmap.serviceLinks);
    this._updateHostCatalog(serviceHostmap.hostCatalog);

    return formattedHostmap;
  },

  /**
   * Get the clusterId associated with a URL string.
   * @param {string} url
   * @returns {string} - Cluster ID of url provided
   */
  getClusterId(url) {
    const catalog = this._getCatalog();

    return catalog.findClusterId(url);
  },

  /**
   * Get a service value from a provided clusterId. This method will
   * return an object containing both the name and url of a found service.
   * @param {object} params
   * @param {string} params.clusterId - clusterId of found service
   * @param {boolean} [params.priorityHost] - returns priority host url if true
   * @param {string} [params.serviceGroup] - specify service group
   * @returns {object} service
   * @returns {string} service.name
   * @returns {string} service.url
   */
  getServiceFromClusterId(params) {
    const catalog = this._getCatalog();

    return catalog.findServiceFromClusterId(params);
  },

  /**
   * @param {String} cluster the cluster containing the id
   * @param {UUID} [id] the id of the conversation.
   *  If empty, just return the base URL.
   * @returns {String} url of the service
   */
  getServiceUrlFromClusterId({cluster = 'us'} = {}) {
    let clusterId = cluster === 'us' ? DEFAULT_CLUSTER_IDENTIFIER : cluster;

    // Determine if cluster has service name (non-US clusters from hydra do not)
    if (clusterId.split(':').length < 4) {
      // Add Service to cluster identifier
      clusterId = `${cluster}:${CLUSTER_SERVICE}`;
    }

    const {url} = this.getServiceFromClusterId({clusterId}) || {};

    if (!url) {
      throw Error(`Could not find service for cluster [${cluster}]`);
    }

    return url;
  },

  /**
   * Get a service object from a service url if the service url exists in the
   * catalog.
   *
   * @param {string} url - The url to be validated.
   * @returns {object} - Service object.
   * @returns {object.name} - The name of the service found.
   * @returns {object.priorityUrl} - The priority url of the found service.
   * @returns {object.defaultUrl} - The default url of the found service.
   */
  getServiceFromUrl(url = '') {
    const service = this._getCatalog().findServiceUrlFromUrl(url);

    if (!service) {
      return undefined;
    }

    return {
      name: service.name,
      priorityUrl: service.get(true),
      defaultUrl: service.get(),
    };
  },

  /**
   * Verify that a provided url exists in the service
   * catalog.
   * @param {string} url
   * @returns {boolean} - true if exists, false otherwise
   */
  isServiceUrl(url) {
    const catalog = this._getCatalog();

    return !!catalog.findServiceUrlFromUrl(url);
  },

  /**
   * Determine if a provided url is in the catalog's allowed domains.
   *
   * @param {string} url - The url to match allowed domains against.
   * @returns {boolean} - True if the url provided is allowed.
   */
  isAllowedDomainUrl(url) {
    const catalog = this._getCatalog();

    return !!catalog.findAllowedDomain(url);
  },

  /**
   * Converts the host portion of the url from default host
   * to a priority host
   *
   * @param {string} url a service url that contains a default host
   * @returns {string} a service url that contains the top priority host.
   * @throws if url isn't a service url
   */
  convertUrlToPriorityHostUrl(url = '') {
    const data = this.getServiceFromUrl(url);

    if (!data) {
      throw Error(`No service associated with url: [${url}]`);
    }

    return url.replace(data.defaultUrl, data.priorityUrl);
  },

  /**
   * @private
   * Simplified method wrapper for sending a request to get
   * an updated service hostmap.
   * @param {object} [param]
   * @param {string} [param.from] - This accepts `limited` or `signin`
   * @param {object} [param.query] - This accepts `email`, `orgId` or `userId` key values
   * @param {string} [param.query.email] - must be a standard-format email
   * @param {string} [param.query.orgId] - must be an organization id
   * @param {string} [param.query.userId] - must be a user id
   * @param {string} [param.token] - used for signin catalog
   * @returns {Promise<object>}
   */
  _fetchNewServiceHostmap({from, query, token, forceRefresh} = {}) {
    const service = 'u2c';
    const resource = from ? `/${from}/catalog` : '/catalog';
    const qs = {...query, format: 'hostmap'};

    if (forceRefresh) {
      qs.timestamp = new Date().getTime();
    }

    const requestObject = {
      method: 'GET',
      service,
      resource,
      qs,
    };

    if (token) {
      requestObject.headers = {authorization: token};
    }

    return this.webex.internal.newMetrics.callDiagnosticLatencies
      .measureLatency(() => this.request(requestObject), 'internal.get.u2c.time')
      .then(({body}) => this._formatReceivedHostmap(body));
  },

  /**
   * Initialize the discovery services and the whitelisted services.
   *
   * @returns {void}
   */
  initConfig() {
    // Get the catalog and destructure the services config.
    const catalog = this._getCatalog();
    const {services, fedramp} = this.webex.config;

    // Validate that the services configuration exists.
    if (services) {
      if (fedramp) {
        services.discovery = fedRampServices;
      }
      // Check for discovery services.
      if (services.discovery) {
        // Format the discovery configuration into an injectable array.
        const formattedDiscoveryServices = Object.keys(services.discovery).map((key) => ({
          name: key,
          defaultUrl: services.discovery[key],
        }));

        // Inject formatted discovery services into services catalog.
        catalog.updateServiceUrls('discovery', formattedDiscoveryServices);
      }

      if (services.override) {
        // Format the override configuration into an injectable array.
        const formattedOverrideServices = Object.keys(services.override).map((key) => ({
          name: key,
          defaultUrl: services.override[key],
        }));

        // Inject formatted override services into services catalog.
        catalog.updateServiceUrls('override', formattedOverrideServices);
      }

      // if not fedramp, append on the commercialAllowedDomains
      if (!fedramp) {
        services.allowedDomains = union(services.allowedDomains, COMMERCIAL_ALLOWED_DOMAINS);
      }

      // Check for allowed host domains.
      if (services.allowedDomains) {
        // Store the allowed domains as a property of the catalog.
        catalog.setAllowedDomains(services.allowedDomains);
      }

      // Set `validateDomains` property to match configuration
      this.validateDomains = services.validateDomains;
    }
  },

  /**
   * Make the initial requests to collect the root catalogs.
   *
   * @returns {Promise<void, Error>} - Errors if the token is unavailable.
   */
  initServiceCatalogs() {
    this.logger.info('services: initializing initial service catalogs');

    // Destructure the credentials plugin.
    const {credentials} = this.webex;

    // Init a promise chain. Must be done as a Promise.resolve() to allow
    // credentials#getOrgId() to properly throw.
    return (
      Promise.resolve()
        // Get the user's OrgId.
        .then(() => credentials.getOrgId())
        // Begin collecting the preauth/limited catalog.
        .then((orgId) => this.collectPreauthCatalog({orgId}))
        .then(() => {
          // Validate if the token is authorized.
          if (credentials.canAuthorize) {
            // Attempt to collect the postauth catalog.
            return this.updateServices().catch(() => {
              this.initFailed = true;
              this.logger.warn('services: cannot retrieve postauth catalog');
            });
          }

          // Return a resolved promise for consistent return value.
          return Promise.resolve();
        })
    );
  },

  /**
   * Initializer
   *
   * @instance
   * @memberof Services
   * @returns {Services}
   */
  initialize() {
    const catalog = new ServiceCatalog();
    const registry = new ServiceRegistry();
    const state = new ServiceState();

    this._catalogs.set(this.webex, catalog);
    this.registries.set(this.webex, registry);
    this.states.set(this.webex, state);

    // Listen for configuration changes once.
    this.listenToOnce(this.webex, 'change:config', () => {
      this.initConfig();
    });

    // wait for webex instance to be ready before attempting
    // to update the service catalogs
    this.listenToOnce(this.webex, 'ready', () => {
      const {supertoken} = this.webex.credentials;
      // Validate if the supertoken exists.
      if (supertoken && supertoken.access_token) {
        this.initServiceCatalogs()
          .then(() => {
            catalog.isReady = true;
          })
          .catch((error) => {
            this.initFailed = true;
            this.logger.error(
              `services: failed to init initial services when credentials available, ${error?.message}`
            );
          });
      } else {
        const {email} = this.webex.config;

        this.collectPreauthCatalog(email ? {email} : undefined).catch((error) => {
          this.initFailed = true;
          this.logger.error(
            `services: failed to init initial services when no credentials available, ${error?.message}`
          );
        });
      }
    });
  },
});
/* eslint-enable no-underscore-dangle */

export default Services;
