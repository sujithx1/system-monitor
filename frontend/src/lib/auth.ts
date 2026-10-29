import { createContext, useContext } from "react";
import type { UserDto, UserRole } from "../shared";

const ROLE_RANK: Record<UserRole, number> = { viewer: 1, operator: 2, admin: 3 };

export function hasRole(user: UserDto, minimum: UserRole): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK[minimum];
}

export interface AuthValue {
  user: UserDto;
  can: (minimum: UserRole) => boolean;
  logout: () => void;
}

export const AuthContext = createContext<AuthValue | null>(null);

/** Only rendered below the signed-in shell, so a user is always present. */
export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside the signed-in application shell");
  return value;
}
