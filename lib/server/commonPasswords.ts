/**
 * Static common-password blocklist (Phase B4).
 *
 * Source justification (phase_b4.md §3): a curated, server-shipped subset of
 * the most frequently observed passwords in public frequency lists (the top
 * of compilations in the style of SecLists' Common-Credentials /
 * rock-you-derived rankings). It is NOT a complete breached-password corpus —
 * it exists to block the handful of passwords attackers try first on a small
 * public service. Shipped in-process: zero network, zero privacy exposure.
 *
 * Matching is exact and case-insensitive (policy: no composition rules, so
 * variants like trailing digits are only caught when they themselves appear
 * in the list).
 */

const ENTRIES = [
  "123456", "password", "123456789", "12345678", "12345", "qwerty", "1234567",
  "111111", "1234567890", "123123", "abc123", "1234", "password1", "iloveyou",
  "1q2w3e4r", "000000", "qwerty123", "zaq12wsx", "dragon", "sunshine",
  "princess", "letmein", "654321", "monkey", "27653", "1qaz2wsx", "123321",
  "qwertyuiop", "superman", "asdfghjkl", "football", "welcome", "jesus",
  "ninja", "mustang", "password123", "admin", "administrator", "root",
  "login", "passw0rd", "trustno1", "baseball", "harley", "ranger", "buster",
  "thomas", "tigger", "robert", "soccer", "batman", "test", "pass",
  "killer", "hockey", "george", "charlie", "andrew", "michelle", "love",
  "sunshine1", "jessica", "pepper", "daniel", "access", "joshua", "maggie",
  "starwars", "silver", "william", "dallas", "yankees", "shadow", "ashley",
  "bailey", "summer", "chelsea", "biteme", "matrix", "secret", "flower",
  "hottie", "loveme", "zaq1zaq1", "password1!", "letmein123", "welcome1",
  "welcome123", "changeme", "default", "guest", "user", "demo", "sample",
  "temporary", "whatever", "donald", "qwerty1", "qazwsx", "q1w2e3r4",
  "112233", "121212", "131313", "696969", "555555", "7777777", "1234qwer",
  "asdf1234", "zxcvbnm", "1q2w3e", "q1w2e3r4t5", "abcd1234", "abcdefg",
  "aaaaaa", "1111", "2222", "789456", "147258369", "987654321", "159753",
  "iloveyou1", "lovely", "forever", "butterfly", "chocolate", "cookie",
  "peanut", "banana", "orange", "purple", "rainbow", "diamond", "ginger",
  "michael", "jennifer", "jordan", "hunter", "bitch", "sexy", "hotstuff",
  "liverpool", "arsenal", "champion", "winner", "money", "cash", "internet",
  "computer", "samsung", "google", "facebook", "twitter", "iphone",
  "android", "windows", "linux", "oracle", "mysql", "postgres", "database",
  "server", "system", "manager", "company", "business", "office", "worker",
  "mailxp", "mailbox", "email", "inbox", "sender", "draft", "quest",
  "security", "secure", "encrypted", "private", "firewall", "network",
  "crypto", "bitcoin", "blockchain", "wallet", "masterkey", "secret123",
  "admin123", "root123", "toor", "pass123", "key", "master", "control",
  "ncc1701", "star trek", "startrek", "pokemon", "minecraft", "fortnite",
  "harrypotter", "lordoftheRings", "starwars1", "batman1", "joker",
  "spiderman", "ironman", "captainamerica", "avengers", "transformers",
] as const;

const COMMON: ReadonlySet<string> = new Set(ENTRIES.map((entry) => entry.toLowerCase()));

/** True when the password (case-insensitively) is on the static blocklist. */
export function isCommonPassword(password: string): boolean {
  return COMMON.has(password.toLowerCase());
}

/** Number of shipped entries — used by the policy test as a sanity check. */
export const COMMON_PASSWORD_COUNT = COMMON.size;
