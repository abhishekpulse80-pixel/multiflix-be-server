import { z } from 'zod';
/** `PATCH /admin/settings/:key` — body is `{ value: <any> }`; type per key enforced in the service. */
export const updateAppSettingBodySchema = z
    .object({
    value: z.unknown(),
})
    .strict();
