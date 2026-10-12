/**
 * `@agentbank/sdk/node`: Node-only helpers.
 *
 * - {@link FileKeyStore}: a 0600 JSON key file for session and spend keys
 *   (testnet keys only; refuses group/world-accessible files).
 *
 * @packageDocumentation
 */

export { FileKeyStore, type FileKeyStoreOptions } from "./keystore/file";
export { loadKey, loadOrCreateKey, MemoryKeyStore, type KeyStore } from "./keystore/memory";
