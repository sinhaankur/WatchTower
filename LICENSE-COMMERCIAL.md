# WatchTower Commercial License

**Version 1.0 · Effective 2026-05-11**

This Commercial License ("License") is an agreement between **The WatchTower Authors** ("Licensor", "we", "us") and the individual or legal entity identified on the executed order form ("Licensee", "you").

This License is offered as an alternative to the open-source licenses that otherwise govern the WatchTower codebase (Apache License 2.0 and Elastic License 2.0; together the "Open Licenses"). Where this Commercial License is in effect for a Licensee, it supersedes the Open Licenses with respect to that Licensee's use of WatchTower.

---

## 1. Definitions

**"WatchTower"** means the software in this repository (https://github.com/sinhaankur/WatchTower) and the binary distributions thereof published by the Licensor, including all components in the root directory and the `pro/` directory, plus future updates the Licensor releases during the Term.

**"Permitted Use"** means the use rights granted under Section 3.

**"Term"** means the period during which this License is in effect for the Licensee, as set out on the order form.

**"Pro Features"** means the features whose stable identifiers are listed in `watchtower/api/edition.py:PRO_FEATURES` and the source code that implements them under the `pro/` directory.

**"Affiliates"** means any entity that controls, is controlled by, or is under common control with the Licensee, where "control" means ownership of more than 50% of voting equity.

---

## 2. Why this license exists

The WatchTower codebase is open-core. The default licenses (Apache 2.0 + ELv2) cover:

- Self-hosted use for any purpose, including internal commercial use
- Forking, modifying, and redistributing the Apache 2.0 portion
- Reading and auditing the ELv2 (`pro/`) source

The ELv2 deliberately does **not** allow:

- Offering WatchTower (or its Pro Features) as a hosted/managed service to third parties
- Removing or circumventing the license-key check on Pro Features
- Stripping copyright or trademark notices

If your intended use falls outside what ELv2 allows — most commonly: you want to **resell WatchTower as a hosted service**, **embed Pro Features in a product you ship to customers**, or **operate without the public-source-availability obligations of ELv2** — you need this Commercial License.

You may also want this License for reasons unrelated to the ELv2 restrictions: a written contract with defined SLA and warranty terms, an indemnification clause your legal team requires, or a clean OEM/reseller arrangement.

---

## 3. License grant

Subject to the Licensee's compliance with this License and the payment of fees described in the order form, the Licensor grants the Licensee, during the Term, a **non-exclusive, non-transferable, non-sublicensable** license to:

1. Use, copy, install, run, and modify WatchTower (including the Pro Features) for the Licensee's own business purposes and for the business purposes of the Licensee's Affiliates.
2. Distribute WatchTower (in source or binary form) to end users **as part of a product or service offered by the Licensee**, where "distribute" means the Licensee remains the responsible party for support, SLA, and end-user terms.
3. Operate WatchTower as a hosted or managed service for the Licensee's customers, including offering Pro Features through that service. This is the right that the default Elastic License 2.0 reserves; this Commercial License grants it explicitly.
4. Remove the public-attribution requirement of the Elastic License 2.0 for binary distributions to the Licensee's end users (the Licensee remains free to add its own attribution and branding).

The grant covers the version of WatchTower distributed during the Term, including any updates the Licensor releases during the Term. Use of versions released **after** the Term ends requires a renewed License or falls back to the default Open Licenses.

---

## 4. What you may not do

Even under this Commercial License, the Licensee may not:

1. **Sublicense WatchTower** as a standalone product to a third party (i.e., reselling the source code itself). Embedding WatchTower in your product as described in Section 3.2 is allowed; selling the source as if it were yours is not.
2. **Remove or alter copyright or license notices** within the source files (you may add your own notices alongside ours).
3. **Use the "WatchTower" name, logo, or trademarks** to imply your fork or distribution is the official WatchTower project. Trademark rights are not granted by this License; see Section 7.
4. **Reverse-engineer the license-key validation** for any purpose other than verifying your own legitimate use under this License.
5. **Use WatchTower in any application where failure could cause death, personal injury, or severe physical or environmental damage** (life-safety, nuclear, aviation control, etc.) without explicit written approval from the Licensor.

Violation of any clause in this Section 4 terminates this License immediately under Section 9 and reverts the Licensee's use rights to the Open Licenses (which the violation may itself also breach).

---

## 5. Fees

Fees are set on the order form executed with the Licensor. Pricing tiers, billing frequency (monthly, annual, perpetual), and any usage-based components (node count, deployment count, user seats) are defined there.

Fees are payable in advance unless otherwise agreed in writing. Unpaid invoices more than 30 days past due may trigger suspension of the License grant in Section 3 until paid; persistent non-payment is a material breach (Section 9).

For current pricing and to request a license, see <https://sinhaankur.github.io/WatchTower/pricing/> or email **opensource@sinhaankur.dev** with subject line "Commercial License Inquiry — [Your Organization]".

---

## 6. Support, warranty, and SLA

This Commercial License includes:

- **Priority support** via the channel specified on the order form (email by default; dedicated channel for higher tiers).
- A target **response SLA** of one business day for priority issues, three business days for non-priority, measured during the Licensor's business hours (US Eastern). Specific SLA terms (response vs. resolution, severity definitions, business-hour windows) are on the order form.
- **Update access** to all WatchTower releases during the Term, including security patches.

WatchTower is provided **"AS IS"** except as expressly stated in this Section. The Licensor disclaims all other warranties, express or implied, including merchantability, fitness for a particular purpose, and non-infringement, to the maximum extent permitted by law. The Licensor's total liability under this License is capped at the fees paid by the Licensee under this License in the twelve months preceding the claim.

---

## 7. Trademarks

"WatchTower" is an unregistered trademark of The WatchTower Authors. This License does **not** grant any trademark rights. You may state that your product uses WatchTower (factual use) but you may not use the name or logo in a way that implies endorsement, partnership, or official affiliation without the Licensor's written consent.

If the Licensor formally registers the WatchTower trademark during the Term, this Section continues to apply; the registration does not grant additional rights to the Licensee.

---

## 8. Confidentiality

Each party shall protect the other's confidential information (including pricing, source code under this License, and non-public technical details) with the same care it uses for its own confidential information, but no less than reasonable care. Confidential information may be disclosed (a) on a need-to-know basis to employees and contractors bound by equivalent obligations, (b) as required by law, or (c) with the disclosing party's prior written consent.

---

## 9. Term and termination

This License runs for the Term specified on the order form. Either party may terminate this License for the other party's material breach if the breach is not cured within 30 days of written notice.

On termination:

1. The Licensee's rights under Section 3 end. Continued use of WatchTower reverts to the Open Licenses (Apache 2.0 + ELv2).
2. The Licensee may continue to operate existing installations of WatchTower versions released during the Term, but only under the Open Licenses going forward. The Licensee is no longer entitled to support, updates, or the SaaS-resale right granted in Section 3.3.
3. Fees paid for the current billing period are non-refundable except where this License is terminated by the Licensee for the Licensor's material breach.
4. Sections 4 (restrictions on Open Licenses still apply), 6 (warranty disclaimer survives), 7 (trademarks), 8 (confidentiality, for three years), 9 (termination effects), 10 (governing law), and 11 (entire agreement) survive termination.

---

## 10. Governing law

This License is governed by the laws of the **State of New York, USA**, without regard to its conflict-of-laws rules. The parties consent to the exclusive jurisdiction of the state and federal courts located in New York County, New York for any dispute arising under or relating to this License.

The parties waive any right to a jury trial in any such dispute.

---

## 11. Entire agreement; amendments

This License, together with any order form referenced or executed by the parties, is the entire agreement between the parties regarding the subject matter and supersedes all prior agreements (oral or written) on the same subject.

Amendments to this License are only effective if in writing and signed by an authorized representative of both parties. Email may constitute writing if the parties expressly agree to that effect.

---

## 12. Contact

To request a commercial license, ask pricing questions, or discuss custom terms, contact:

**The WatchTower Authors**
Email: opensource@sinhaankur.dev
Project: <https://github.com/sinhaankur/WatchTower>
Pricing: <https://sinhaankur.github.io/WatchTower/pricing/>

For security disclosures (not licensing), use GitHub Security Advisories on the project.
