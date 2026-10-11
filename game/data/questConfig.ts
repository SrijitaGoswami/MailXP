/**
 * Single configuration module for the local game flow (Phase 4 loop + Phase 5
 * quest list). Everything gameplay-tunable lives here: quest data, statuses,
 * DraftCoin economics, XP/level rules, NPC dialogue and control hints.
 *
 * This is LOCAL sample data only — no APIs, no real email delivery, no wallet
 * transactions, no network calls of any kind.
 */

// --------------------------------------------------------------------- types --

export type QuestKind = "delivery" | "reply";

export type QuestStatus = "locked" | "active" | "completed";

export interface Quest {
  /** Stable id (used in bridge snapshots and reports). */
  id: string;
  /** `delivery` = physical mail loop (Phase 4); `reply` = review-and-send job. */
  kind: QuestKind;
  title: string;
  description: string;
  /** DraftCoin paid to the player when the quest completes. */
  reward: number;
  /** XP granted when the quest completes. */
  xpComplete: number;
  /** How many handled mail items this quest contributes to the HUD mail count. */
  mailOnComplete: number;

  // --- reply quests only (ignored by `delivery` quests) ---
  /** Who the sample reply is addressed to (editable in the review panel). */
  recipient?: string;
  /** Subject line the Response Worker drafts (editable). */
  subject?: string;
  /** Why this job exists — shown in the quest panel. */
  inboxPrompt?: string;
  /** Deterministic local classification result of the Understanding Worker. */
  category?: string;
  /** Deterministic sample reply body the Response Worker prepares. */
  draftBody?: string;
}

/** Local starting balance for a fresh run. */
export const QUEST_START_BALANCE = 0;

/** Currency label used in the HUD, bridge text and panels. */
export const CURRENCY = "DraftCoin";

/**
 * The quest list — one job active at a time, finishing one auto-starts the
 * next (decision recorded in the Phase 5 plan).
 */
export const QUESTS: readonly Quest[] = [
  {
    id: "deliver-letter",
    kind: "delivery",
    title: "Deliver today's letter",
    description: "Pick up the sample mail from the mailbox and hand it to the Officer.",
    reward: 25,
    xpComplete: 15,
    mailOnComplete: 1,
  },
  {
    id: "reply-invoice",
    kind: "reply",
    title: "Reply: invoice dispute",
    description: "A customer says invoice #1042 was charged twice and wants an explanation.",
    reward: 20,
    xpComplete: 15,
    mailOnComplete: 1,
    recipient: "dana@northwind.test",
    subject: "Re: Invoice #1042 — duplicate charge",
    inboxPrompt: "Customer reports a duplicate charge on invoice #1042.",
    category: "Billing question",
    draftBody:
      "Hi Dana — thanks for flagging invoice #1042. I checked the ledger and the second " +
      "charge was a duplicate authorization; it has been voided and will drop off in 3–5 " +
      "business days. Sorry for the confusion — let me know if it is still showing.\n\n— MailXP Desk",
  },
  {
    id: "reply-demo",
    kind: "reply",
    title: "Reply: reschedule the demo",
    description: "The client cannot make Thursday's demo and asks for a new time.",
    reward: 20,
    xpComplete: 15,
    mailOnComplete: 1,
    recipient: "sam@bluelake.test",
    subject: "Re: Demo reschedule",
    inboxPrompt: "Client asks to move Thursday's demo to another slot.",
    category: "Scheduling request",
    draftBody:
      "Hi Sam — no problem at all. I can do Friday 10:00 or Monday 14:00 your time. " +
      "Reply with whichever suits you best and I will send an updated invite with the " +
      "agenda attached.\n\n— MailXP Desk",
  },
  {
    id: "reply-export",
    kind: "reply",
    title: "Reply: broken CSV export",
    description: "A user reports the CSV export button does nothing in the reports tab.",
    reward: 20,
    xpComplete: 15,
    mailOnComplete: 1,
    recipient: "priya@lantern.test",
    subject: "Re: CSV export not downloading",
    inboxPrompt: "User reports the CSV export button does nothing.",
    category: "Bug report",
    draftBody:
      "Hi Priya — thanks for the clear report. The export fails when the date range is " +
      "empty; a fix is rolling out today. As a workaround, pick any range covering at " +
      "least one day and the CSV downloads normally.\n\n— MailXP Desk",
  },
];

// --------------------------------------------------------------- economics --

export const ECONOMY = {
  /** DraftCoin charged for one simulated send (config-decided: 5). */
  sendCost: 5,
  /** DraftCoin paid on a successful simulated send (config-decided: 20). */
  sendReward: 20,
  /** XP for the Understanding Worker's local classification. */
  xpClassify: 5,
  /** XP for a confirmed simulated send. */
  xpSend: 10,
  /** XP needed per level (config-decided: 100 XP per level). */
  xpPerLevel: 100,
} as const;

/** Interaction reach, in px, measured between two foot positions. */
export const INTERACT_RADIUS = 64;

/** Objective line per quest stage (shown in the canvas HUD and React mirror). */
export const OBJECTIVES = {
  pickup: "Pick up the sample mail from the mailbox in the mail room (top of the office).",
  deliver: "Deliver the sample mail to the Officer (top-right of the office).",
  classify: "New job: the Understanding Worker is classifying the request — watch it work.",
  draft: "The Response Worker is preparing a deterministic sample reply.",
  review: "Review the drafted reply below the game: edit recipient, subject and message, then confirm the send.",
  send: "Simulated send confirmed — the mail-bird is carrying your reply out of the office.",
  allComplete: "All jobs complete — explore the office and talk to the crew.",
} as const;

export type QuestStage = keyof typeof OBJECTIVES;

/** Status lines mirrored into the canvas HUD and the React aria-live panel. */
export const STATUSES = {
  intro: "Arrow keys / WASD to walk. Walk up to something and press E to interact.",
  pickedUp: "Picked up the sample mail — now find the Officer.",
  delivered: "Delivery complete!",
  mailboxAgain: "The mailbox is empty — the letter is already with the Officer.",
  alreadyCarrying: "You are already carrying the sample mail.",
  nothing: "Nothing to interact with here.",

  classifyStart: "New job accepted — the Understanding Worker is heading over to read it.",
  drafting: "The Response Worker is preparing the sample reply…",
  draftReady: "Draft ready — review it in the reply panel below the game.",
  reviewOpened: "Reply review open — edit the fields, then confirm the send.",
  reviewKept: "Draft kept — reopen it from the reply panel, or press E at the Response Worker.",
  notEnough: "Not enough DraftCoin — this send costs 5 and you cannot cover it yet.",
  sending: "Simulated send confirmed — no API call, no real email, no wallet transaction.",
  sent: "Reply sent!",
  questComplete: "Job complete!",
  levelUp: "Level up!",
  allComplete: "All jobs complete!",
  understandingIdle: "The Understanding Worker classifies requests while they are active.",
  responseIdle: "The Response Worker drafts the reply for the active job.",
} as const;

/** One line per NPC, shown when the player talks without a deliverable hand-off. */
export const NPC_DIALOGUE: Record<string, string> = {
  officer: "Morning! There is a sample letter in the mailbox — bring it here, please.",
  agent: "The mailbox in the mail room (tile floor, top of the office) still has a letter waiting.",
  monkey: "Ooh ooh! Deliveries pay 25 DraftCoin each — press E near the Officer to hand it over.",
  intern: "I sorted this morning's post — one letter is still in the mailbox for pickup.",
};

/** Shown after every quest is finished (free roam). */
export const POST_DELIVERY_DIALOGUE: Record<string, string> = {
  officer: "Fine work — the letter and every reply are handled. Take a well-earned break.",
  agent: "All jobs are done: one delivery and three replies. Enjoy the quiet office.",
  monkey: "Ooh ooh! All four jobs complete — you are the office legend!",
  intern: "Everything in the outbox is cleared — nice work today.",
};

/**
 * Legacy Phase 4 lookup kept so existing call sites keep working: the single
 * config module now describes the whole quest list above.
 */
export const QUEST = {
  startingBalance: QUEST_START_BALANCE,
  reward: QUESTS[0].reward,
  currency: CURRENCY,
  deliveryNpcId: "officer",
  itemName: "sample mail",
} as const;
