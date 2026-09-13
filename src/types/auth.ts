export type AuthContext = {
  userId: string;
  /** Null until the user provides an email during onboarding. */
  email: string | null;
};
