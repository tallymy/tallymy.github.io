// Source-owned release gates. No URL/query/localStorage/window flag can enable them.
export const mainHostApproved=()=>true;
export const localRecoveryApproved=()=>true;
// Root must provide a reviewed same-window/nonce/exact-origin SDP-only bootstrap facade.
// Main index CSP is unchanged; this must not silently fall back to broad LAN fetch.
export const pairingFetch=()=>mainHostApproved()===true&&localRecoveryApproved()===true?()=>import('./signal-facade.mjs').then(m=>m.createSignalFacadeClient):null;   // lazy: gates.mjs has no imports so the off build loads just this file
