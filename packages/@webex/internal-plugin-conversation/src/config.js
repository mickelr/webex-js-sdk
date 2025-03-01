/*!
 * Copyright (c) 2015-2020 Cisco Systems, Inc. See LICENSE file.
 */

export default {
  conversation: {
    allowedInboundTags: {
      'webex-mention': ['data-object-type', 'data-object-id', 'data-object-url'],
    },
    allowedOutboundTags: {
      'webex-mention': ['data-object-type', 'data-object-id', 'data-object-url'],
    },
    // eslint-disable-next-line no-empty-function
    inboundProcessFunc: () => {},
    // eslint-disable-next-line no-empty-function
    outboundProcessFunc: () => {},
    allowedInboundStyles: [],
    allowedOutboundStyles: [],
    /**
     * Max height for thumbnails generated when sharing an image
     * @type {number}
     */
    thumbnailMaxHeight: 960,
    /**
     * Max width for thumbnails generated when sharing an image
     * @type {number}
     */
    thumbnailMaxWidth: 640,
    /**
     * Primarily for testing. When true, decrypting an activity will create a
     * sister property with the original encrypted string
     * @type {Boolean}
     */
    keepEncryptedProperties: false,
    decryptionFailureMessage: 'This message cannot be decrypted',

    /**
     * config value to perform decryption on inbound conversations and activities
     */
    includeDecryptionTransforms: true,

    /**
     * config value to perform decryption on outbound conversations and activities
     */
    includeEncryptionTransforms: true,
  },
};
