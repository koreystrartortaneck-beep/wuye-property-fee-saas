# China App Launch Compliance Skill Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Create a project-local skill that audits mainland China WeChat Mini Program and iOS/Android App launch compliance, including property-fee-specific rules.

**Architecture:** Keep the executable review workflow in a concise `SKILL.md`, split change-prone legal and platform knowledge into directly linked reference modules, and standardize deliverables with one report template. Require live verification against official sources for every real audit.

**Tech Stack:** Markdown Agent Skill, YAML frontmatter, Skills CLI validation scripts, official Chinese government and platform web sources.

---

### Task 1: Establish the skill contract

**Files:**
- Create: `skills/china-app-launch-compliance/SKILL.md`
- Create: `tests/china-app-launch-compliance/check_skill.sh`

1. Write a failing structural check for required frontmatter, workflow sections, references, and report template.
2. Run the check and verify it fails because the skill does not exist.
3. Initialize the skill with the official `init_skill.py` helper.
4. Replace the template with the minimal review contract.
5. Run the structural check and verify the main contract passes.

### Task 2: Add evidence and general mainland rules

**Files:**
- Create: `skills/china-app-launch-compliance/references/evidence-and-sources.md`
- Create: `skills/china-app-launch-compliance/references/mainland-general.md`

1. Add structural assertions for source hierarchy, live verification, effective date, legal/platform distinction, and uncertainty handling.
2. Verify the new assertions fail.
3. Add evidence rules and the conditional mainland filing/licensing decision guide.
4. Verify the assertions pass.

### Task 3: Add platform and privacy modules

**Files:**
- Create: `skills/china-app-launch-compliance/references/wechat-miniprogram.md`
- Create: `skills/china-app-launch-compliance/references/ios-android-app.md`
- Create: `skills/china-app-launch-compliance/references/privacy-and-data.md`

1. Add checks for all three modules and their required decision topics.
2. Verify the checks fail.
3. Add conditional platform submission, account/privacy, permissions, SDK, and deletion checks.
4. Verify the checks pass.

### Task 4: Add payment and property-fee modules

**Files:**
- Create: `skills/china-app-launch-compliance/references/payment-and-settlement.md`
- Create: `skills/china-app-launch-compliance/references/property-fee-project.md`

1. Add checks for merchant identity, fund flow, split settlement, secondary clearing, authorization, fee basis, invoicing, and householder data access.
2. Verify the checks fail.
3. Add the payment and property-fee decision guides with escalation boundaries.
4. Verify the checks pass.

### Task 5: Add the report template and validate the package

**Files:**
- Create: `skills/china-app-launch-compliance/assets/compliance-report-template.md`

1. Add checks for scope, assumptions, compliance matrix, missing facts, source register, and disclaimer sections.
2. Verify the checks fail.
3. Add the report template.
4. Run the project structural check and the skill creator validation utility.
5. Run a representative物业费 scenario and inspect that conclusions are conditional and evidence-backed.

