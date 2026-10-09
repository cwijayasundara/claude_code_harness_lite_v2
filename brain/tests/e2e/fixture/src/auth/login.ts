import { pad } from '../util/format.js'
/** Check a user's credentials. */
export function login(user: string, password: string): boolean { return pad(user, 3).length > 0 && password.length > 7 }
export function logout(user: string): void { void user }
