import { randomInt } from 'node:crypto';
export function generateOtp4() {
    return String(randomInt(0, 10_000)).padStart(4, '0');
}
