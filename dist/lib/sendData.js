/** Consistent success envelope for mobile clients: `{ data: ... }`. */
export function sendData(res, payload, statusCode = 200) {
    res.status(statusCode).json({ data: payload });
}
