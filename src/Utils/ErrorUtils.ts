import {ErrnoException} from '../Error/ErrnoException.js';

/**
 * Error Utils
 */
export class ErrorUtils {

    public static isFsError(err: unknown): err is ErrnoException {
        return (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            typeof (err as any).code === 'string'
        );
    }

}