/** Instagram-style: letters, numbers, periods, underscores; 3–30 chars; no leading/trailing handled in assignment. */
export const USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9._]{1,28}[a-z0-9])$/;

export function isValidUsernameShape(name: string): boolean {
  return name.length >= 3 && name.length <= 30 && USERNAME_REGEX.test(name);
}
