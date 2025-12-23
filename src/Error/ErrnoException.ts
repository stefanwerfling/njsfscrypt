/**
 * Errno exception
 */
export class ErrnoException extends Error {

    public code?: string;
    public errno?: number;
    public syscall?: string;
    public path?: string;

}