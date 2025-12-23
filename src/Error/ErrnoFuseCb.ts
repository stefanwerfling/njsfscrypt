export class ErrnoFuseCb extends Error {

    protected _fuseErr: number;

    public constructor(fuseErr: number, msg?: string) {
        super(msg);
        this._fuseErr = fuseErr;
    }

    public getFuseError(): number {
        return this._fuseErr;
    }

}