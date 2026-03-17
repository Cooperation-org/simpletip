# SimpleTip

**One-click tipping for journalists, authors, and the people they write about.**

SimpleTip is an embeddable web component that lets readers tip content creators — and the subjects of their stories — directly from any website. Ghost, WordPress, Substack, any HTML page. One script tag, one click.

A journalist covers a doctor in a war zone. A blogger profiles refugee teachers. A local reporter writes about a community organizer. SimpleTip lets readers support both the storyteller and the people in the story, in one click.

## The Problem

Independent journalists and impact-focused writers have no good way to receive tips where their work lives. Existing tools (Ko-fi, Buy Me a Coffee, Patreon) require readers to leave the article, create accounts on yet another platform, and only pay the author — never the communities and people being covered.

Meanwhile, the people *in* the stories — the doctors, teachers, organizers, activists — get attention but no direct support from readers who are moved by their work.

## How SimpleTip Works

### For readers

**First time you click a tip button**, a wallet is created for you automatically — no signup, no form. A popup opens so you can add funds via card, Apple Pay, Google Pay, PayPal, Venmo, Zelle, M-Pesa, crypto, whatever your SimpleTip node supports. Takes 30 seconds. You can optionally link your email or Google account to protect your balance and access it from any device.

**From then on, every tip is one click.** Click $3 under an article → green flash → done. Your wallet balance decrements. No checkout, no popup, no leaving the page. Works on every site that has the widget — your wallet follows you everywhere.

**Split tips.** When an article covers real people or causes, a slider lets you split your tip between the author and the subject. 50/50, 70/30, whatever feels right. Both get paid.

**Your balance is safe.** Funds are stored server-side, not in your browser. If you link your email, you can recover your wallet from any device. No account creation required — just an email, whenever you're ready.

### For authors and journalists

1. Sign up at your SimpleTip node (e.g. tips.linkedtrust.us)
2. Choose how you want to get paid — PayPal, Venmo, Zelle, M-Pesa, bank transfer, crypto, anything
3. Get your embed code
4. Paste it into your blog template

```html
<script src="https://tips.linkedtrust.us/simpletip.js"></script>
<simple-tip author="james-okafor" author-name="James Okafor"></simple-tip>
```

That's it. Works on Ghost, WordPress, Substack custom HTML, Hugo, Jekyll, raw HTML — anywhere JavaScript runs.

### Split tips for impact journalism

The feature that makes SimpleTip different: when your article covers someone who could use direct support, link them as a subject.

```html
<simple-tip
  author="james-okafor"
  author-name="James Okafor"
  subject="sudan-er-teams"
  subject-label="Sudan ER Medical Teams">
</simple-tip>
```

Readers see a slider. They choose how to split. Both the journalist and the subject get paid.

Subjects register their own payout method — or the author can set one up on their behalf. Tips to subjects who haven't registered yet are held until they claim them.

## Why This Matters for Journalism

**Local news is dying.** The business model is broken. Advertising doesn't sustain independent reporting. Paywalls lock out the communities being served. Subscriptions work for a few big outlets but not for the freelance journalist covering their city council or the reporter embedded in a refugee camp.

**Tips won't replace salaries, but they change the relationship.** When a reader can load a wallet once and then tip a journalist $3 with one click at the bottom of an article — without leaving the page, without any checkout flow — it creates a direct connection between the person doing the work and the person who values it.

**Impact journalism deserves impact funding.** When a story about a community health worker or a wrongfully detained person moves readers to act, that impulse should have somewhere to go beyond "thoughts and prayers." Split tips channel that impulse into direct support.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Any website (Ghost, WordPress, Substack, HTML)     │
│                                                     │
│  <simple-tip author="james">                        │
│    ┌───────────────────────────────────┐             │
│    │  Tip James Okafor       $1 $3 $5 │  ← web     │
│    │  [====slider====] 50/50          │    component│
│    │  Sudan ER Medical Teams          │             │
│    └───────────────────────────────────┘             │
└──────────────────────┬──────────────────────────────┘
                       │ API calls (CORS)
                       ▼
┌─────────────────────────────────────────────────────┐
│  SimpleTip node (e.g. tips.linkedtrust.us)          │
│                                                     │
│  ┌─────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │  Auth    │  │  Ledger  │  │  Payouts          │  │
│  │         │  │          │  │                   │  │
│  │ Email   │  │ Balances │  │ PayPal            │  │
│  │ Google  │  │ Tips     │  │ Venmo / Zelle     │  │
│  │ ATProto │  │ Splits   │  │ M-Pesa            │  │
│  │         │  │ Receipts │  │ Bank transfer      │  │
│  └─────────┘  └──────────┘  │ USDT / crypto     │  │
│                              │ Wise (intl)       │  │
│                              └───────────────────┘  │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │  Federation (ATProto, optional)              │   │
│  │  Tip records published to the network.       │   │
│  │  Other nodes can read them. Your history     │   │
│  │  is portable — move to another node anytime. │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Federation — not locked in

Anyone can run a SimpleTip node. The code is open source. A node is:

- A backend that processes payments (Stripe, PayPal, whatever works in your region)
- A ledger that tracks tips and balances
- Optionally: publishes records to ATProto so tips are portable and verifiable

LinkedTrust runs the first node. But a press freedom org in Kenya could run one using M-Pesa. A university press could run one for their journals. A journalism co-op in Latin America could run one using MercadoPago. Same web component, same protocol, different payment rails for different communities.

### The nonprofit model

When a SimpleTip node is run by a nonprofit:

- Reader contributions may be tax-deductible
- No KYC burden for small disbursements
- The nonprofit is the trusted custodian
- Transparent — tip records can be public

For-profit nodes work too — charge a processing fee, like any payment platform. The protocol doesn't require a specific business model.

## Payment Methods

### Money in (readers funding their wallet or paying per-tip)

| Method | Coverage | Integration |
|--------|----------|-------------|
| Credit/debit card | Global | Stripe Checkout |
| Apple Pay | iOS/Safari | Stripe (built in) |
| Google Pay | Android/Chrome | Stripe (built in) |
| PayPal | Global | PayPal Checkout |
| Venmo | US | PayPal (built in) |
| Bank transfer (ACH) | US | Stripe / Plaid |
| SEPA | EU | Stripe |
| Pix | Brazil | Stripe |
| UPI | India | Razorpay or Stripe India |
| GCash | Philippines | PayMongo |
| M-Pesa | East Africa | Chimoney or Flutterwave |
| Crypto (USDT, USDC) | Global | Coinbase Commerce or direct |
| ILP / Open Payments | ILP wallets | @interledger/open-payments |

### Money out (authors and subjects getting paid)

| Method | Coverage | Integration |
|--------|----------|-------------|
| PayPal | Global | PayPal Payouts API |
| Venmo | US | PayPal (built in) |
| Zelle | US | Manual or bank API |
| Cash App | US | Manual |
| Bank transfer (ACH) | US | Stripe Connect or Wise |
| Bank transfer (SWIFT) | International | Wise API |
| M-Pesa | East Africa | Chimoney |
| Airtime top-up | Africa, Asia | Chimoney |
| USDT / USDC | Global | Direct transfer |
| MoneyGram | Global (cash pickup) | MoneyGram as a Service |
| Western Union | Global (cash pickup) | Manual |
| GoodDollar | UBI recipients | GoodDollar SDK |
| ILP wallet | ILP-enabled wallets | Open Payments |

The node operator decides which payment methods to support. The minimum viable set: Stripe (cards, Apple Pay, Google Pay) for money in, PayPal Payouts for money out. That covers most of the world.

## Comparison

| | Ko-fi | Buy Me a Coffee | Patreon | SimpleTip |
|---|---|---|---|---|
| Embed in any page | Link out | Link out | Link out | **Yes — web component** |
| Split tips (author + subject) | No | No | No | **Yes** |
| Reader wallet across sites | No | No | No | **Yes** |
| Author picks any payout method | PayPal | Stripe | Stripe | **Any** |
| Works on Substack/Ghost/WP | Link only | Link only | Link only | **Native embed** |
| Federated / open source | No | No | No | **Yes** |
| Nonprofit / tax deductible | No | No | No | **Yes (nonprofit nodes)** |
| One-click tip (wallet) | No | No | No | **Yes — fund once, tip everywhere** |

## Use Cases

**Independent journalists** covering local government, conflict zones, or underserved communities. Readers tip at the bottom of every article. The journalist gets paid directly for their work.

**Human rights reporters** writing about detained individuals, refugees, or victims of state violence. Split tips let readers support both the reporter and the people in the story — or their families, legal funds, or local organizations helping them.

**Community bloggers** profiling local businesses, organizers, artists, and activists. Tips flow to the people making a difference, not just the person writing about them.

**Newsletter writers** on Substack, Ghost, or Buttondown. Embed the widget in your template. Every issue becomes an opportunity for readers to say "this was worth something."

**Podcast show notes** and video descriptions. Embed the widget on your episode page. Guests and subjects get tipped alongside the host.

**Nonprofit storytelling.** Organizations like ProPublica, The Marshall Project, or local news nonprofits embed SimpleTip in their stories. Reader tips supplement grant funding and demonstrate audience engagement to funders.

## Running Your Own Node

SimpleTip is designed to be run by anyone. The first node is operated by [LinkedTrust](https://linkedtrust.us), a nonprofit focused on trust and verification in digital systems.

To run your own node:

1. Clone this repo
2. Set up a Stripe account (or your preferred payment processor)
3. Configure payout methods for your region
4. Deploy the backend
5. Point the web component at your node's API

Full deployment docs coming. If you're interested in running a node, open an issue or contact us.

## Tech Stack

- **Web component:** Vanilla JS, Shadow DOM, zero dependencies. One file: `simpletip.js`
- **Backend:** Node.js + Express. Simple REST API.
- **Database:** SQLite (single node) or Postgres (production scale).
- **Payments in:** Stripe Checkout (cards, Apple Pay, Google Pay, bank), PayPal.
- **Payments out:** PayPal Payouts, Wise API, Chimoney (M-Pesa), manual for others.
- **Auth:** Anonymous-first — wallet auto-created on first tip. Optional email linking or Google OAuth for recovery. ATProto planned.
- **Federation:** ATProto (planned) — publish tip records for portability and cross-node verification.

## Status

**Working demo:** Web component, zero-friction wallet (auto-created, email recovery), tip ledger, author registration, split tips, multi-method funding, balance badge.

**Next:**
- Stripe integration (real payments)
- Google OAuth one-click wallet linking
- Magic link recovery emails
- Author payout dashboard
- ATProto record publishing
- Ghost blog theme integration

## License

MIT

## Built by

[LinkedTrust](https://linkedtrust.us) — building trust infrastructure for the open web.
