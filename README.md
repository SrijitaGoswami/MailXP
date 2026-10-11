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
  <img src="https://img.shields.io/badge/Blockchain-Algorand%20TestNet-000000?style=for-the-badge" alt="Algorand TestNet"/>
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

The experience combines:

- A 2D workplace exploration game.
- Interactive characters and workplace scenarios.
- Real Gmail connectivity through Google OAuth.
- AI-assisted email understanding and writing.
- Progression systems, experience points, and achievements.
- A planned DraftCoin game economy powered by Algorand TestNet and Pera Wallet.

MailXP is designed to make professional communication feel less like an obligation and more like a game worth returning to.

### Project at a glance

| Category | Description |
|---|---|
| Project | MailXP |
| Product category | Gamified productivity and AI email assistant |
| Game style | Top-down 2D pixel-art workplace |
| Primary experience | Explore, interact, read, write, and manage emails |
| Email provider | Gmail |
| Authentication | Google OAuth |
| AI direction | Gemini-powered email intelligence |
| Backend direction | Node.js and Express |
| Frontend direction | React and JavaScript |
| Database direction | MongoDB |
| Blockchain direction | Algorand TestNet |
| Wallet direction | Pera Wallet |
| Planned game currency | DraftCoin (`$DRAFT`) |
| Development approach | Incremental, phase-based implementation |

> **Development status:** The Gmail integration milestones B8, B8A, and B8B have been completed, and B9 has been reported complete with 617/617 tests passing and build and migration checks passing. B10 is the next planned AI Email Intelligence milestone. Other game, AI, and blockchain capabilities should be treated according to their actual implementation status in the repository.

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

The product has two connected dimensions:

**The game layer**

- Explore an interactive workplace.
- Discover characters and scenarios.
- Complete missions and communication challenges.
- Earn experience and unlock progression.
- Personalize the experience as the game expands.

**The productivity layer**

- Connect a real Gmail account.
- Access authorized email functionality.
- Understand incoming messages with AI assistance.
- Identify important messages, tasks, and deadlines.
- Prepare better email drafts.
- Keep the user in control of real-world communication.

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

### 📧 2. Real Gmail Integration

MailXP connects users to Gmail through Google's OAuth authorization flow.

The integration is designed to support:

- Google account authorization.
- Secure Gmail connection management.
- Access to authorized Gmail functionality.
- A one-Gmail-account-per-MailXP-account rule.
- Connection status management.
- Revocation and disconnection handling.
- A foundation for email synchronization and AI analysis.

Users must explicitly authorize access. The application should only request the permissions required for its actual features.

### 🤖 3. AI Email Intelligence

The planned AI intelligence layer is designed to help users understand incoming messages and respond effectively.

Potential capabilities include:

- Email summarization.
- Message classification.
- Priority assessment.
- Extraction of tasks and deadlines.
- Suggested replies.
- Professional tone improvements.
- Context-aware writing assistance.
- Structured results for use in the game interface.

These capabilities are being developed incrementally rather than treated as a single completed feature.

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

### 🪙 6. DraftCoin Economy

DraftCoin (`$DRAFT`) is the proposed in-game currency for the broader MailXP ecosystem.

The planned economy may support rewards, cosmetic unlocks, and purchases through an in-game marketplace.

The intended blockchain direction uses Algorand TestNet and Pera Wallet. Blockchain functionality remains subject to the implementation and verification of the corresponding milestones.

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
5. **Complete the activity** — Write a draft, improve a response, identify important details, or complete the assigned task.
6. **Use AI assistance when appropriate** — Request summaries, writing suggestions, or other supported intelligence features.
7. **Review the result** — Evaluate whether the objective has been achieved.
8. **Progress** — Earn applicable game rewards, gain experience, and unlock additional content.
9. **Continue exploring** — Return to the workplace and take on another challenge.

Actual Gmail actions must be distinguished from simulated missions. Sending an email, changing account settings, or performing another real-world action should require the appropriate authorization and user intent.

---

## 🧠 AI Email Intelligence

AI is intended to be a central component of MailXP, but it must operate as a controlled application capability rather than an unrestricted agent.

### Planned processing pipeline

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

Identify useful categories, such as work, education, recruitment, informational messages, and other supported classifications.

**Priority assessment**

Help distinguish messages that may require timely attention from messages that can wait.

**Task and deadline extraction**

Identify possible action items, dates, requested responses, and commitments.

**Draft assistance**

Help users generate or improve professional email drafts using relevant context.

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

MailXP follows a modular application architecture intended to separate the game experience, business logic, integrations, and persistence.

```text
+--------------------------------------------------+
|                 MAILXP FRONTEND                  |
|                                                  |
|  +----------------+   +-----------------------+  |
|  | 2D Game World  |   | Productivity UI       |  |
|  | Player / NPCs  |   | Inbox / Drafts / AI   |  |
|  +----------------+   +-----------------------+  |
|                                                  |
|       React Components and Client State          |
+--------------------------+-----------------------+
                           |
                           | HTTPS / API
                           v
+--------------------------------------------------+
|                 BACKEND API                      |
|                                                  |
|  Authentication and Authorization                |
|  Gmail Connection Management                     |
|  Email and Draft Services                        |
|  AI Intelligence and Job Processing              |
|  Game Progression and Reward Validation          |
|  Wallet / Blockchain Services                    |
+--------------------------+-----------------------+
                           |
              +------------+-------------+
              |            |             |
              v            v             v
       +------------+ +----------+ +-------------+
       | MongoDB    | | Gemini   | | Google      |
       | Persistence| | AI API   | | Gmail APIs  |
       +------------+ +----------+ +-------------+
              |
              v
       +--------------------------+
       | Algorand / Pera Wallet   |
       | Planned Web3 Integration |
       +--------------------------+
```

The diagram represents the intended logical architecture. Individual connections should be considered implemented only when supported by the actual repository.

### Architecture principles

**Modularity:** Keep game logic, Gmail operations, AI processing, and blockchain integrations separated.

**Server-side enforcement:** Sensitive operations and authorization checks belong on the backend.

**Structured interfaces:** Use explicit request schemas and validated response formats between modules.

**Failure isolation:** Gmail, AI, and blockchain failures should not unnecessarily crash the core game.

**Observability:** Record appropriate errors, job states, and operational events without logging secrets or unnecessary private email content.

**Incremental delivery:** Introduce new capabilities through isolated, testable development phases.

---

## 🛠️ Technology Stack

The following technologies represent the project's established direction. Confirm the exact installed versions and current dependencies in the repository before deployment.

| Technology | Purpose |
|---|---|
| React | Frontend components and application interfaces |
| JavaScript | Application development |
| Tailwind CSS | Styling and responsive UI |
| Node.js | Backend JavaScript runtime |
| Express.js | HTTP API and middleware |
| MongoDB | Persistent application data |
| Google OAuth 2.0 | Google account authorization |
| Gmail API | Authorized Gmail operations |
| Gemini API | Planned AI email intelligence |
| Algorand | Planned blockchain economy |
| Algorand Standard Assets | Planned DraftCoin asset |
| Pera Wallet Connect | Planned wallet connection |
| Git and GitHub | Version control and collaboration |

The actual dependency list, versions, rendering or game engine, job queue, test framework, and deployment platform should be determined from the repository rather than inferred from this overview.

---

## 📁 Project Structure

The following is a conceptual organization for the application. Adapt it to the existing repository instead of creating duplicate folders simply to match the diagram.

```text
mailxp/
│
├── client/                       # React frontend, if separated
│   ├── public/
│   │   └── assets/
│   │       ├── characters/
│   │       ├── tiles/
│   │       ├── environments/
│   │       └── ui/
│   │
│   └── src/
│       ├── components/
│       ├── game/
│       │   ├── world/
│       │   ├── player/
│       │   ├── characters/
│       │   └── interactions/
│       ├── pages/
│       ├── services/
│       ├── hooks/
│       └── styles/
│
├── server/                       # Backend, if separated
│   ├── routes/
│   ├── controllers/
│   ├── services/
│   ├── middleware/
│   ├── models/
│   ├── jobs/
│   ├── integrations/
│   │   ├── gmail/
│   │   ├── gemini/
│   │   └── algorand/
│   └── tests/
│
├── docs/
│   ├── architecture/
│   ├── development-phases/
│   └── reports/
│
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

**Note:** This tree is illustrative, not a claim about the exact files currently present in the repository. Keep the existing structure and update this section to reflect the real project layout.

---

## 🚀 Getting Started

### Prerequisites

Install the tools required by the actual application:

- Node.js and npm.
- Git.
- MongoDB, or a supported MongoDB connection.
- A Google Cloud project configured for OAuth and the required Gmail API access.
- A Gemini API key when implementing or testing AI features.
- Algorand TestNet and Pera Wallet configuration when working on the blockchain milestone.

### 1. Clone the repository

```bash
git clone <YOUR_REPOSITORY_URL>
cd <YOUR_PROJECT_DIRECTORY>
```

Replace the placeholders with your actual repository URL and project directory.

### 2. Install dependencies

If the project uses a single root `package.json`:

```bash
npm install
```

If the frontend and backend use separate package files, install dependencies in each relevant directory:

```bash
cd client
npm install
cd ../server
npm install
```

Use the commands matching the actual repository structure.

### 3. Configure environment variables

Create the required local environment file based on `.env.example` or the application's existing configuration.

```bash
cp .env.example .env
```

On Windows PowerShell, you can use:

```powershell
Copy-Item .env.example .env
```

Fill in the required values for your local environment. Do not commit actual credentials.

### 4. Start the application

Check the root and individual `package.json` files for the real scripts.

Typical commands, **only if defined by the project**, may look like:

```bash
npm run dev
```

For a separate frontend and backend, start each service using its own documented development command.

### 5. Verify the application

After startup:

1. Confirm the frontend loads.
2. Confirm the backend starts without configuration errors.
3. Check database connectivity.
4. Verify the authentication flow.
5. Test Gmail connection and disconnection.
6. Run the existing test suite.
7. Test AI or blockchain functionality only when its corresponding configuration is available.

---

## 🔑 Environment Configuration

MailXP integrates with services that may require secrets and application-specific configuration.

The table below lists configuration categories, not exact environment variable names. Use the names defined in the project's source code and `.env.example`.

| Configuration | Purpose |
|---|---|
| Server port | Backend listening port |
| Database connection | MongoDB URI or equivalent database configuration |
| Session or token secret | Server-side authentication and session security, where applicable |
| Google OAuth client ID | Google authorization configuration |
| Google OAuth client secret | Server-side OAuth exchange, where applicable |
| Google OAuth callback URL | Registered authorization callback |
| Gmail API configuration | Required scopes and service settings |
| Gemini API key | AI provider access |
| Algorand network configuration | TestNet or another explicitly supported network |
| DraftCoin asset ID | Asset identifier after actual asset creation |
| Pera Wallet configuration | Supported wallet connection settings |

Do not copy these labels into `.env` as variable names unless they match the code.

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
| B9 | Gmail integration completion and verification | Reported complete; 617/617 tests reported passing, with build and migration checks passing |
| B10 | Gemini AI Email Intelligence | Next planned milestone |

### B10 — Gemini AI Email Intelligence

The next planned phase is focused on integrating intelligence into the email workflow.

The intended scope includes:

- AI-generated email summaries.
- Message classification.
- Priority assessment.
- Extraction of tasks and deadlines.
- Prompt-injection protection.
- Usage limits.
- Durable background jobs where required.
- Database persistence.
- Frontend integration.
- Automated testing and implementation reporting.

B10 should be considered complete only when its implementation, error handling, tests, and verification report support that conclusion.

### Subsequent product milestones

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

The B9 milestone has been reported with **617 passing tests out of 617**, alongside successful build and migration checks. This is a milestone-specific report, not a guarantee that every future feature or production environment is tested.

Run the actual repository test commands before making claims about the current branch.

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
4. Follow the project's existing JavaScript and coding conventions.
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

MailXP is an evolving project combining an interactive 2D workplace game, real Gmail integration, AI-assisted productivity, and a planned blockchain-enabled game economy.

The immediate engineering priority is to complete and verify the Gemini AI Email Intelligence milestone while maintaining the reliability of the Gmail integration already established in earlier phases.

The broader objective is to build a cohesive product in which the game, AI assistant, email workflows, progression system, and optional digital economy work together as a single experience.

---

<p align="center">
  <strong>MailXP</strong>
  <br/>
  <em>Work smarter. Write better. Level up.</em>
</p>

<p align="center">
  Made for a world where productivity can be an adventure.
</p>
