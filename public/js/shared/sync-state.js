// Gate full map-state snapshots on application authentication, independently
// of Socket.IO's transport connection. A delayed/legacy anonymous snapshot
// must never satisfy reconnect recovery; wait for the post-login state before
// replacing authoritative local terrain.
export class AuthenticatedMapReload {
    constructor() {
        this._authenticated = false;
        this._reloadNeeded = true;
    }

    onConnect() {
        this._authenticated = false;
        this._reloadNeeded = true;
    }

    onAuthenticated() {
        this._authenticated = true;
    }

    onDisconnect() {
        this._authenticated = false;
        this._reloadNeeded = true;
    }

    acceptsMapState(dataKey, currentMapKey) {
        return this._authenticated && dataKey === currentMapKey;
    }

    shouldReplaceUnified(terrainIsUnified) {
        return this._reloadNeeded || !terrainIsUnified;
    }

    onMapStateApplied() {
        if (!this._authenticated) return false;
        this._reloadNeeded = false;
        return true;
    }

    get authenticated() { return this._authenticated; }
    get reloadNeeded() { return this._reloadNeeded; }
}
