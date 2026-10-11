# MailXP — Turn Your Inbox Into an Adventure

<p align="center">
  <strong>An AI-powered email productivity game where real-world communication meets an interactive 2D pixel-art workplace.</strong>
</p>

<p align="center">
  <em>Play your role. Master your inbox. Level up your career.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Project-MailXP-7C3AED?style=for-the-badge" alt="MailXP Project"/>
  <img src="https://img.shields.io/badge/Game-2D%20Pixel%20Art-EC4899?style=for-the-badge" alt="2D Pixel Art"/>
  <img src="https://img.shields.io/badge/AI-Gemini%20Integration-4285F4?style=for-the-badge" alt="AI Integration"/>
  <img src="https://img.shields.io/badge/Email-Gmail%20OAuth-EA4335?style=for-the-badge" alt="Gmail OAuth"/>
</p>

<p align="center">
  <strong>From writing your first professional email to managing an entire virtual workplace.</strong>
</p>

---

## Table of Contents

- [Overview](#-overview)
- [The Vision](#-the-vision)
- [The Problem](#-the-problem)
- [Our Solution](#-our-solution)
- [Core Features](#-core-features)
- [The Game World](#-the-game-world)
- [Gameplay Loop](#-gameplay-loop)
- [AI Email Intelligence](#-ai-email-intelligence)
- [Gmail Integration](#-gmail-integration)
- [Agentic Architecture](#-agentic-architecture)
- [Blockchain and DraftCoin](#-blockchain-and-draftcoin)
- [Technical Architecture](#-technical-architecture)
- [Technology Stack](#-technology-stack)
- [Project Structure](#-project-structure)
- [Getting Started](#-getting-started)
- [Environment Configuration](#-environment-configuration)
- [Development Roadmap](#-development-roadmap)
- [Security and Privacy](#-security-and-privacy)
- [Testing and Quality Assurance](#-testing-and-quality-assurance)
- [Design Philosophy](#-design-philosophy)
- [Future Possibilities](#-future-possibilities)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🎮 Overview

**MailXP** is an AI-powered productivity game that transforms email management and professional communication into an interactive gaming experience.

Instead of treating email as another boring task, MailXP places players inside a lively, top-down, 2D pixel-art workplace. Players interact with characters, receive workplace challenges, learn how to write better emails, and progress through an experience built around communication, productivity, and career development.

The current application combines a Phaser-powered office game, a Next.js web app and API, player accounts and progression, Google OAuth-based Gmail access, a synchronized in-game inbox, and optional AI analysis of email messages. The AI feature is advisory: it summarizes and classifies a message and extracts possible action items and deadlines; it does not write or send replies.

MailXP is designed to make professional communication feel less like an obligation and more like a game worth returning to.

### Project at a glance

| Category | Description |
|---|---|
| Application | Next.js App Router application with React and TypeScript |
| Game | Phaser 3 top-down pixel-art office |
| API | Versioned Next.js route handlers under `/api/v1` |
| Database | PostgreSQL accessed through Prisma |
| Accounts | Email/password sessions and Google OAuth integration |
| Email | Gmail synchronization, plain-text inbox, connection management |
| AI | Optional Gemini-based advisory message analysis |
| Tests | Vitest |
| Delivery status | B10 AI analysis is implemented; blockchain and wallet integration are not part of the current stack |

> **Implementation status:** Gmail OAuth, mailbox synchronization, the in-game inbox, game state/economy services, and B10 advisory email analysis have implementation reports in [`docs/`](./docs/). The current AI analysis implementation does not create drafts or perform Gmail write actions. Use the source code and phase reports—not the long-term product vision below—as the authority for what is available today.

---

## 🌍 The Vision

Email is one of the most widely used tools in professional life, yet it is often associated with repetitive tasks, overflowing inboxes, confusing messages, and the pressure to respond correctly.

MailXP imagines a different experience.

What if managing your inbox felt like completing missions in a game?

What if learning to write professional emails happened naturally through workplace challenges?

What if your inbox had an intelligent assistant that helped you understand what matters, while you explored a virtual office and progressed through your career?

MailXP brings these ideas together in a single interactive environment.

The long-term vision is to create a productivity platform in which **real communication, AI assistance, game progression, and digital ownership work together**.

---

## ❗ The Problem

### 1. Email overload

People receive messages from colleagues, recruiters, educational institutions, clients, services, and other sources. Finding the important information can take considerable time.

### 2. Difficulty writing professional emails

Students, job seekers, interns, and early-career professionals may struggle with:

- Choosing the right tone.
- Writing effective subject lines.
- Asking for information professionally.
- Following up on applications.
- Responding to workplace requests.
- Communicating clearly and concisely.

### 3. Repetitive productivity workflows

Reading, categorizing, prioritizing, drafting, and following up on emails can become repetitive.

### 4. Traditional productivity tools lack engagement

Most email tools prioritize efficiency but provide limited motivation to develop communication skills or maintain consistent productivity habits.

### 5. Learning professional communication can be intimidating

Real workplace situations can feel high-pressure. A simulated environment can provide opportunities to practise before handling similar situations in real life.

---

## 💡 Our Solution

MailXP combines an interactive game with practical productivity functionality.

Players enter a virtual workplace, interact with characters, complete communication challenges, and use AI assistance to understand and compose emails.

The current product connects two experiences:

**The game layer**

- Explore an interactive workplace.
- Discover characters and scenarios.
- Explore the office using the Phaser game interface.
- Interact with game characters and open game screens.
- Manage player progression, rewards, inventory, and shop state.

**The productivity layer**

- Connect a real Gmail account.
- Access authorized email functionality.
- Synchronize and read authorized Gmail messages in the in-game inbox.
- Request Gemini-powered summaries, classifications, priorities, action items, and deadlines.
- Keep analysis advisory-only; the current integration does not send email or create drafts.

The goal is not to replace Gmail. It is to build an engaging layer around email productivity and professional skill development.

---

## ✨ Core Features

### 🕹️ 1. Interactive 2D Pixel-Art Workplace

MailXP uses a top-down, 2D workplace environment rather than a conventional dashboard as its primary game experience.

The intended experience includes:

- A navigable office environment.
- A player-controlled character.
- Interactive non-player characters (NPCs).
- Office locations and points of interest.
- Contextual interaction prompts.
- Workplace missions and dialogue.
- Game interfaces that complement the environment.

The workplace should feel like a cohesive game world, not simply a website decorated with pixel art.

### 📧 2. Gmail Connection and Inbox

Users can connect a Google account through OAuth and synchronize Gmail messages into the MailXP inbox. The server enforces at most one connected Gmail account per MailXP account and provides explicit connection management.

The implemented inbox flow includes:

- A 30-day initial history window, followed by incremental reconciliation.
- A "Sync now" action and queued sync work.
- Cursor-paginated, newest-first message listing and per-message detail.
- Plain-text message display; HTML is not rendered or stored.
- Attachment metadata only; attachment bytes are not downloaded.
- Cleanup of synchronized messages when a connection is released or deleted.

The current Gmail API integration is read-only. Sending, drafting, labeling, or marking messages read is not implemented.

### 🤖 3. AI Email Intelligence

When configured with a Gemini API key, MailXP can queue advisory analysis for synchronized Gmail messages. Results are shown alongside the message in the in-game inbox and include:

- A short summary, category, and priority.
- Potential action items and deadlines.
- A clear status for queued, running, completed, limited, stale, or failed analysis.
- Manual analyze/retry controls and an optional pause setting.

Analysis runs in the durable server-side job pipeline, is bounded by an input size and per-player daily usage limit, and validates model output before saving it. The default daily limit is 20 analyses per player per UTC day. AI output is guidance only: MailXP does not use it to send messages or change Gmail.

### 🎯 4. Missions and Workplace Challenges

The game is designed around scenarios inspired by professional communication.

Example missions include:

- Replying to a recruiter.
- Asking a professor for clarification.
- Sending a professional follow-up.
- Responding to a manager's request.
- Preparing an internship application.
- Summarizing an important email.
- Identifying an action item in a long conversation.

Missions can provide context, constraints, and objectives that guide the player toward a useful outcome.

### 📈 5. Player Progression

The progression system can connect productive actions and learning activities with game rewards.

Planned progression mechanics include:

- Experience points (XP).
- Player levels.
- Mission completion.
- Achievements.
- Unlockable cosmetic items.
- Character and workplace customization.
- A record of completed challenges.

Rewards should encourage useful behaviour rather than incentivize unnecessary email activity.

### 🪙 6. Game Economy

The application includes server-backed player state, rewards, inventory, a shop, and purchase/ledger flows. These are application features, not blockchain transactions. DraftCoin on Algorand and Pera Wallet remain product ideas; this repository does not currently provide a live blockchain or wallet integration.

### 🔐 7. Security-First Account Management

Account and integration management are foundational parts of the product.

The design includes:

- Google OAuth verification.
- A single active Gmail connection per MailXP account.
- Explicit disconnection and revocation.
- Backend validation of authenticated requests.
- Protected handling of access credentials.
- Server-side authorization checks.

---

## 🏢 The Game World

MailXP's workplace is intended to be the main environment through which players discover the product's functionality.

### Characters

The planned character direction includes a player-controlled worker and distinct workplace personalities.

| Character | Intended role |
|---|---|
| Officer | A workplace authority figure who can introduce tasks and expectations. |
| Agent | A character associated with assistance, guidance, or assigned work. |
| Monkey | A distinctive personality that can add humour and memorable interactions. |
| Intern | A relatable early-career character who can participate in learning-oriented scenarios. |
| Player character | The worker controlled by the user while exploring and interacting with the office. |

These roles are conceptual descriptions, not a claim that every character or dialogue sequence is already implemented.

### Interactive environments

The workplace can expand to include:

- Reception and common areas.
- Individual desks and workstations.
- Meeting rooms.
- A manager's office.
- A task or mission area.
- An inbox or email interaction station.
- A reward and customization area.

Every environment should have a gameplay purpose. The goal is to connect exploration, interaction, and productivity rather than create empty scenery.

### Visual direction

The intended aesthetic is:

- Top-down 2D pixel art.
- Clear silhouettes and readable character animations.
- Consistent tile sizes and sprite proportions.
- A cohesive office colour palette.
- Carefully designed interface overlays.
- Subtle animations and responsive interactions.
- A distinction between the game world and productivity interfaces.

Game assets should be deliberately selected or created to maintain visual consistency across the environment.

---

## 🔁 Gameplay Loop

The central gameplay loop connects workplace exploration with email-related activities.

1. **Enter the workplace** — Load into the game world and take control of the player character.
2. **Explore and interact** — Move around the office and discover characters, stations, and tasks.
3. **Receive a mission** — Encounter a communication challenge or an authorized email-related task.
4. **Understand the context** — Review the message, objective, and relevant information.
5. **Complete the activity** — Identify important details or action items, or work through a simulated communication challenge. Creating or sending Gmail drafts is not currently supported.
6. **Use AI assistance when appropriate** — Request summaries, writing suggestions, or other supported intelligence features.
7. **Review the result** — Evaluate whether the objective has been achieved.
8. **Progress** — Earn applicable game rewards, gain experience, and unlock additional content.
9. **Continue exploring** — Return to the workplace and take on another challenge.

Actual Gmail actions must be distinguished from simulated missions. Sending an email, changing account settings, or performing another real-world action should require the appropriate authorization and user intent.

---

## 🧠 AI Email Intelligence

The B10 implementation provides optional, advisory-only analysis of synchronized Gmail messages. It operates as a controlled server-side capability, not as an unrestricted agent.

### Processing pipeline

```text
Authorized Gmail Message
          |
          v
Backend Authentication
          |
          v
Message Retrieval and Validation
          |
          v
Content Normalization
          |
          v
AI Email Intelligence
          |
          +----------------------+
          |          |           |
          v          v           v
      Summary   Classification  Tasks
          |          |           |
          +----------------------+
                     |
                     v
             Validated Result
                     |
                     v
             Persistent Job State
                     |
                     v
             Frontend / Game UI
```

### Email intelligence capabilities

**Summarization**

Produce concise explanations of lengthy messages and conversations.

**Classification**

Assign one of the supported categories: work, personal, finance, shopping, travel, notification, promotion, social, or other.

**Priority assessment**

Help distinguish messages that may require timely attention from messages that can wait.

**Task and deadline extraction**

Identify possible action items, dates, requested responses, and commitments.

**Draft assistance**

Generating or editing drafts is a possible future capability. The current B10 feature does not draft or send messages.

### AI safety requirements

Email content is untrusted input. A message must not be treated as an instruction that can override application rules.

The intelligence layer should:

- Treat email bodies and attachments as untrusted data.
- Defend against prompt injection.
- Validate structured AI output.
- Enforce usage limits.
- Handle timeouts and model failures.
- Track processing states.
- Use durable jobs where asynchronous processing is required.
- Avoid unnecessary disclosure of private message content.
- Keep external email actions behind explicit authorization and appropriate user confirmation.

AI-generated summaries and recommendations should be presented as assistance, not as guaranteed facts.

---

## 📬 Gmail Integration

Real Gmail connectivity is one of MailXP's defining technical components.

### OAuth connection flow

```text
User
 |
 v
MailXP Account
 |
 v
Google OAuth Authorization
 |
 v
Backend Callback and Verification
 |
 v
Validate Account Ownership
 |
 v
Enforce One Gmail Connection
 |
 v
Store Connection Securely
 |
 v
Authorized Gmail Operations
```

The implementation should verify the OAuth flow on the backend and avoid relying on frontend-only checks for account security.

### One Gmail account per MailXP account

MailXP follows a strict account-linking rule:

**Each MailXP account may have only one active Gmail connection.**

The connection-management system is designed to prevent multiple active Gmail connections for the same MailXP user and to handle disconnection and revocation correctly.

### Gmail integration principles

- Use the official Google OAuth authorization flow.
- Request only necessary permissions.
- Validate OAuth state and callback parameters.
- Associate the authorized Google identity with the correct MailXP user.
- Handle expired or revoked credentials.
- Avoid exposing access tokens or refresh tokens to the browser.
- Provide a clear disconnect experience.
- Do not send, delete, or modify real emails without the required authorization and user intent.

Gmail permissions, available operations, and the exact OAuth scopes must reflect the capabilities implemented in the application.

---

## 🧩 Agentic Architecture

MailXP is intended to grow from an interactive game into a coordinated productivity environment.

In this context, an agentic system means that separate application components can perform well-defined tasks, pass structured results to one another, and coordinate work under backend-enforced rules.

It does not mean allowing an AI model to control the entire application without restrictions.

### Logical components

| Component | Responsibility |
|---|---|
| Game interaction layer | Handles player movement, environmental interactions, and mission entry points. |
| Player and progression layer | Manages player state, XP, levels, and mission progress. |
| Gmail integration layer | Handles authorized email access and account connections. |
| Email intelligence layer | Performs summarization, classification, prioritization, and task extraction. |
| Draft assistance layer | Helps generate and improve email drafts. |
| Job processing layer | Tracks asynchronous processing and failures where required. |
| Reward engine | Validates eligible game actions and calculates rewards. |
| Economy layer | Coordinates game currency and any implemented marketplace functionality. |
| Wallet integration layer | Connects eligible blockchain features to the user's wallet. |
| Persistence layer | Stores application data with appropriate validation and access controls. |

### Important design principle

The backend remains responsible for authorization, persistence, validation, reward eligibility, and real-world actions.

AI can recommend or prepare an action, but it must not bypass the application rules that govern whether that action is permitted.

---

## ⛓️ Blockchain and DraftCoin

MailXP's proposed Web3 direction introduces an optional blockchain-based economy around its game experience.

### DraftCoin (`$DRAFT`)

DraftCoin is the planned digital asset intended to represent the game's reward and spending currency.

The design direction is to use an Algorand Standard Asset (ASA) on Algorand TestNet, with Pera Wallet serving as the intended wallet connection.

### Proposed economic flow

```text
Complete Eligible Game Challenge
               |
               v
       Backend Validates
               |
               v
       Reward Eligibility
               |
               v
        DraftCoin Reward
               |
               v
       Eligible Game Items
               |
               v
       Marketplace / Unlocks
```

The exact reward-distribution and spending mechanisms depend on the implemented blockchain architecture.

### Planned blockchain components

- Algorand TestNet integration.
- DraftCoin ASA configuration.
- Pera Wallet connection.
- Wallet address association.
- Transaction creation and verification.
- Backend validation of eligible rewards.
- A possible marketplace for supported digital items.
- Transaction status and error handling.

### Off-chain and on-chain responsibilities

| Off-chain application | Blockchain layer |
|---|---|
| User accounts | DraftCoin asset |
| Gmail connection metadata | Verified asset transactions |
| Email drafts and AI results | On-chain transfers where implemented |
| Missions and progression | Wallet-controlled asset ownership |
| XP and game state | Blockchain-based reward or purchase records where applicable |
| AI usage and job processing | Other explicitly implemented on-chain operations |

Not every game action needs to be recorded on-chain. Keeping routine gameplay and AI processing off-chain can reduce cost and unnecessary transaction overhead.

### Important limitations

- TestNet assets are for development and testing, not guaranteed real-world monetary value.
- DraftCoin must not be described as a live or tradable asset unless its creation and relevant functionality are verified.
- Pera Wallet support must not be claimed complete until the actual connection and transaction flows have been tested.
- MainNet deployment, NFTs, and external marketplace integrations are future possibilities, not assumed current features.
- Reward rules must be enforced by trusted backend logic to reduce fraudulent reward claims.

---

## 🏗️ Technical Architecture

MailXP is a single Next.js application. The App Router serves the game and account screens as well as the versioned API. Server-only domain modules own authentication, persistence, Gmail and Gemini provider calls, queued jobs, and game rules; React components and the Phaser game communicate with those services through the API client.

```text
Browser: Next.js / React UI + Phaser office game
                         |
                  /api/v1 route handlers
                         |
     +-------------------+----------------------+
     |                   |                      |
Authentication      Game / inbox          AI analysis
and sessions         domain services       durable jobs
     |                   |                      |
     +-------------------+----------------------+
                         |
               Prisma + PostgreSQL
                  /             \
            Gmail API        Gemini API
```

Gmail and Gemini calls are made by server-side integration modules. Gmail synchronization and AI analysis use the server-side job/outbox pipeline. Application data is stored in PostgreSQL through Prisma; no separate Express or MongoDB service is required.

### Architecture principles

**Modularity:** Keep game logic, Gmail operations, AI processing, and persistence separated.

**Server-side enforcement:** Sensitive operations and authorization checks belong on the backend.

**Structured interfaces:** Use explicit request schemas and validated response formats between modules.

**Failure isolation:** Gmail, AI, and blockchain failures should not unnecessarily crash the core game.

**Observability:** Record appropriate errors, job states, and operational events without logging secrets or unnecessary private email content.

**Incremental delivery:** Introduce new capabilities through isolated, testable development phases.

---

## 🛠️ Technology Stack

The current stack is reflected in `package.json`:

| Technology | Purpose |
|---|---|
| Next.js 16 | Application framework, App Router, server-rendered pages, and API route handlers |
| React 19 | User interface |
| TypeScript | Application and API implementation |
| Phaser 3 | Interactive 2D office game |
| PostgreSQL | Persistent application data |
| Prisma 7 | Database schema, client, and migrations |
| Google OAuth and Gmail API | Account connection and read-only mailbox integration |
| `@google/genai` | Optional server-side Gemini email analysis |
| Tailwind CSS 4 | Styling |
| Vitest | Unit and integration tests |

---

## 📁 Project Structure

```text
app/                     # Next.js pages and /api/v1 route handlers
components/              # React screens, API client, and game UI
game/                    # Phaser game setup, scenes, assets config, and state
lib/server/              # Server-only domain services and integrations
prisma/                  # PostgreSQL schema and ordered migrations
public/assets/            # Static game and shop assets
docs/                     # API contracts, phase plans, and implementation reports
package.json              # App scripts and dependencies
.env.example              # Local environment variable template
```

API route handlers are intentionally thin; most reusable server-side logic lives in `lib/server/`. Phase reports in `docs/` record implementation scope, decisions, and validation for individual milestones.

---

## 🚀 Getting Started

### Prerequisites

- Node.js compatible with the Next.js version in `package.json`, and npm.
- PostgreSQL for local application data.
- A Google Cloud OAuth client only if you want to test Google sign-in or Gmail integration.
- A Gemini API key only if you want to enable AI email analysis.

### 1. Clone the repository

```bash
git clone https://github.com/SrijitaGoswami/MailXP.git
cd MailXP
```

### 2. Install dependencies and configure the database

```bash
npm install
```

Copy the checked-in template to a local `.env` file, then set `DATABASE_URL` to a PostgreSQL database that you control. Use your own credentials; `.env` is local configuration and must not be committed.

```powershell
Copy-Item .env.example .env
```

Apply the repository's Prisma migrations:

```bash
npx prisma migrate deploy
```

### 3. Run the application

```bash
npm run dev
```

Open `http://localhost:3000`. The app requires `DATABASE_URL`. Google OAuth variables and the token-encryption key are needed for Google account connection; a Gemini API key is optional and enables AI analysis. Exact names and safe placeholders are listed in `.env.example`.

### 4. Run checks

```bash
npm test
npm run build
```

---

## 🔑 Environment Configuration

Configure only the integrations you intend to run. `.env.example` is the source of truth for variable names and defaults.

| Configuration | Purpose |
|---|---|
| `DATABASE_URL` | Required PostgreSQL connection string used by the app and Prisma |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID; required for Google account connection |
| `GOOGLE_CLIENT_SECRET` | Server-side OAuth client secret |
| `GOOGLE_REDIRECT_URI` | OAuth callback URL; defaults in the template to the local callback route |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | Base64-encoded 32-byte key used to encrypt stored Google refresh tokens |
| `GEMINI_API_KEY` | Optional Gemini key; without it, AI analysis is unavailable |
| `GEMINI_MODEL` | Optional model identifier; defaults to `gemini-2.5-flash` |
| `AI_DAILY_LIMIT` | Optional per-player daily analysis budget; defaults to 20 |
| `WORKER_ENABLED` | Optional worker switch; setting it to `false` disables the background worker |

### Secrets management rules

- Never commit `.env` files containing secrets.
- Keep `.env.example` free of real credentials.
- Never expose Google OAuth client secrets or refresh tokens in frontend code.
- Do not put privileged blockchain signing keys in the browser.
- Validate required configuration during application startup.
- Use different credentials for local development, testing, and production.
- Rotate credentials if they are accidentally exposed.

---

## 🗺️ Development Roadmap

MailXP is developed through explicit phases to keep implementation manageable and verifiable.

### Completed and upcoming milestones

| Phase | Focus | Status |
|---|---|---|
| B8 | Gmail integration foundation | Reported complete |
| B8A | Gmail integration hardening and related requirements | Reported complete |
| B8B | Enforcing one active Gmail connection and real revocation handling | Reported complete |
| B9 | Gmail integration completion and verification | Implemented; see [`docs/B9_REPORT.md`](./docs/B9_REPORT.md) |
| B10 | Gemini AI Email Intelligence | Implemented; see [`docs/B10_REPORT.md`](./docs/B10_REPORT.md) |

### B10 — Gemini AI Email Intelligence

The B10 implementation adds optional advisory analysis to synchronized Gmail messages:

- AI-generated email summaries.
- Message classification.
- Priority assessment.
- Extraction of tasks and deadlines.
- A durable background job flow with coalescing, failure handling, and retry.
- Per-player daily usage accounting and a global pause control.
- A bounded input and strict validation of structured model output.
- Inbox and settings UI for analysis, usage, pause, and retry states.

The feature fails closed when no Gemini API key is configured. Analysis output is not an instruction to the application: no model output triggers an external Gmail action. Consult [`docs/BACKEND_PHASE_PLAN.md`](./docs/BACKEND_PHASE_PLAN.md) for the current backend sequencing before starting follow-on work.

### Future product milestones

Beyond the current backend sequence, the broader product direction includes the following areas. Their exact phase numbers and completion states should follow the project's planning documents.

**Game experience**
- Refine the 2D game world.
- Implement player movement and interactions.
- Build character dialogues and workplace missions.
- Integrate the game with email-related workflows.

**Productivity experience**
- Connect inbox data to the user interface.
- Add AI summaries and task-oriented views.
- Support draft creation and revision.
- Provide clear controls for real-world email actions.

**Progression**
- Add XP, levels, mission completion, and achievements.
- Introduce reward validation and player customization.
- Connect game challenges to meaningful productivity outcomes.

**Web3 economy**
- Configure DraftCoin on Algorand TestNet.
- Implement and test Pera Wallet connectivity.
- Verify transactions and reward eligibility.
- Introduce eligible marketplace functionality where appropriate.

**Production readiness**
- Complete security reviews.
- Improve monitoring and diagnostics.
- Validate performance under realistic usage.
- Document deployment, recovery, and operational procedures.

This roadmap is directional. The project's phase reports and source code remain the authority for exact sequencing and status.

---

## 🧪 Testing and Quality Assurance

MailXP requires testing across game behaviour, account security, external integrations, and AI processing.

### Backend testing

Important areas include:

- Authentication and authorization.
- Gmail account-linking restrictions.
- OAuth callback validation.
- Revocation and disconnection.
- Database persistence.
- API input validation.
- Error handling.
- Rate limiting and usage limits.

### AI testing

Important areas include:

- Valid and invalid model responses.
- Structured output validation.
- Empty or unusually long messages.
- Prompt-injection attempts in email content.
- Provider failures and timeouts.
- Duplicate job processing.
- Retry behaviour.
- Usage-limit enforcement.
- Task and deadline extraction quality.

### Frontend and game testing

Important areas include:

- Player movement and interaction.
- Game state transitions.
- Mission completion.
- Loading and error states.
- Responsive layouts.
- Keyboard and mouse interaction.
- Gmail connection status.
- AI result presentation.
- Accessibility and readability.

### Blockchain testing

Before treating a blockchain feature as complete, verify:

- Correct network configuration.
- Wallet connection and disconnection.
- Asset identifiers.
- Transaction signing and submission.
- Transaction confirmation.
- Invalid transaction handling.
- Reward eligibility.
- Duplicate reward prevention.

### Current verification note

The B10 implementation report records **648 passing tests**, a successful TypeScript check and Next.js build, and successful Prisma validation and migration-status checks at the time of that report. This is a milestone-specific record, not a live CI result. Run `npm test` and `npm run build` against the current checkout to verify it.

---

## 🔐 Security and Privacy

MailXP handles potentially sensitive information, including real email content and account authorization credentials. Security must remain a core architectural requirement.

### Authentication and authorization

- Validate user identity on the backend.
- Verify ownership of requested resources.
- Enforce the single-Gmail-connection rule server-side.
- Protect sensitive API endpoints.
- Handle session expiry and revoked credentials.
- Do not trust client-provided user IDs or reward values.

### Gmail security

- Use explicit OAuth authorization.
- Request minimum necessary permissions.
- Store tokens securely on the server.
- Handle revocation and authorization failures.
- Avoid logging email bodies and credentials.
- Provide a clear account-disconnection mechanism.

### AI security

- Treat incoming email content as untrusted.
- Prevent message text from overriding system and application rules.
- Validate AI-generated output before using it.
- Restrict AI-triggered actions to approved capabilities.
- Apply usage limits and sensible processing boundaries.
- Avoid transmitting unnecessary personal information to external AI services.

### Blockchain security

- Verify transaction details independently.
- Do not trust frontend-reported rewards or balances.
- Keep signing authority separate from untrusted client input.
- Prevent duplicate reward claims.
- Explain TestNet limitations clearly.
- Never request a user's seed phrase or private wallet key.

### User control

AI suggestions must not silently become real-world actions. The user should understand when the system is analysing an email, preparing a draft, or requesting permission to perform an external action.

---

## 🎨 Design Philosophy

MailXP should feel like a game first, while remaining genuinely useful as a productivity tool.

### 1. Gameplay over dashboard overload

The office world should provide the primary navigation experience. Productivity interfaces should appear in meaningful contexts rather than overwhelming the player with conventional dashboards.

### 2. Consistent pixel-art assets

Character sprites, tiles, animations, and environmental objects should share a consistent visual language.

### 3. AI as an assistant, not a replacement

AI should help users understand and compose emails while preserving their control over the final communication.

### 4. Real functionality over superficial gamification

Points and rewards should support real learning and useful activities rather than reward meaningless clicks or excessive email engagement.

### 5. Modular development

Game systems, Gmail integration, AI processing, and blockchain services should be independently testable.

### 6. Trust by design

Users must understand which features access real email data, which activities are simulated, and which operations can create external consequences.

---

## 🔮 Future Possibilities

The following ideas may extend the MailXP experience as the core product matures.

### Advanced workplace simulation

- Multiple office environments.
- More interactive NPCs.
- Branching conversations.
- Mission chains and career progression.
- New workplace roles and scenarios.

### Intelligent productivity

- Context-aware reply suggestions.
- Follow-up reminders.
- Better task and deadline tracking.
- Personalized communication feedback.
- Additional email-provider integrations where justified.

### Expanded game economy

- Additional cosmetic items.
- Character customization.
- Office themes and decorations.
- A marketplace for eligible digital goods.
- Optional blockchain-based ownership.
- NFTs or other digital collectibles if they provide meaningful value.

### Social and competitive features

- Optional leaderboards.
- Community challenges.
- Skill-based achievements.
- Cooperative workplace scenarios.
- Progress-sharing features with appropriate privacy controls.

These are possible future directions, not commitments to deliver every feature.

---

## 🤝 Contributing

Contributions that improve the product's usability, security, architecture, gameplay, and maintainability are welcome.

### Suggested contribution workflow

1. Review the existing project structure and phase documentation.
2. Identify a focused issue or improvement.
3. Create a dedicated branch.
4. Follow the project's existing TypeScript and formatting conventions.
5. Add or update tests for behavioural changes.
6. Run relevant checks before submitting.
7. Document changes to configuration, APIs, or database behaviour.
8. Submit a pull request with a clear explanation of the change.

### Contribution principles

- Do not introduce duplicate implementations of existing modules.
- Do not bypass authentication or authorization checks.
- Do not commit credentials or private email data.
- Keep AI and blockchain functionality behind validated interfaces.
- Avoid claiming a feature is complete without verification.
- Follow the current phase plan when making changes to in-progress functionality.

---

## 📄 License

Choose and add a license before distributing the project publicly.

Until a license is explicitly added to the repository, do not assume that the source code is licensed for unrestricted reuse, modification, or redistribution.

---

## 👨‍💻 Project Status

MailXP currently combines an interactive 2D workplace game, account and game-state services, Gmail inbox synchronization, and optional Gemini-based advisory analysis. The B9 and B10 phase reports document the implemented Gmail and AI capabilities. DraftCoin on Algorand, Pera Wallet, email drafting/sending, and other future ideas are not current, verified features.

---

<p align="center">
  <strong>MailXP</strong>
  <br/>
  <em>Work smarter. Write better. Level up.</em>
</p>

<p align="center">
  Made for a world where productivity can be an adventure.
</p>
