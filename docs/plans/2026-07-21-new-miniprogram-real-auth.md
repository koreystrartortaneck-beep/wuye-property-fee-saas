# New Mini Program Real Auth Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deploy the new mini program identity with real WeChat login, phone authorization, CloudBase routing, and privacy handling while retaining Mock payments.

**Architecture:** Keep the existing NestJS JWT owner session and MySQL `WxUser` model. Implement WeChat API calls behind `WxApi`, use CloudRun environment variables for credentials, and keep all mini program requests behind `wx.cloud.callContainer`.

**Tech Stack:** NestJS 11, Jest 30, Prisma 6, native WeChat Mini Program, WeChat CloudRun.

---

### Task 1: Verify and harden the real WeChat backend

**Files:**
- Modify: `apps/api/src/wx/wx.real.ts`
- Modify: `apps/api/src/wx/wx-cloud.service.ts`
- Create: `apps/api/src/wx/wx.real.spec.ts`

**Steps:**
1. Add a failing test for missing WeChat credentials.
2. Run `pnpm --dir apps/api test -- --runInBand src/wx/wx.real.spec.ts` and confirm the expected failure.
3. Add minimal configuration validation without logging secrets.
4. Add tests for successful `code2session`, rejected login code, phone lookup, and missing subscription template.
5. Run the focused test and confirm all cases pass.
6. Run `pnpm --dir apps/api build`.

### Task 2: Validate the mini program real-auth configuration

**Files:**
- Modify: `apps/miniprogram/config.js`
- Modify: `apps/miniprogram/project.config.json`
- Modify: `apps/miniprogram/app.json`
- Modify: `apps/miniprogram/pages/bind-house/*`
- Create: `apps/miniprogram/components/privacy-popup/*`
- Create: `apps/miniprogram/utils/subscribe.js`
- Modify: `apps/miniprogram/pages/pay-confirm/pay-confirm.js`

**Steps:**
1. Set `mockAuth` to `false` and retain the new AppID/environment ID.
2. Validate all JSON files with Node JSON parsing.
3. Load all changed JavaScript files with a syntax checker.
4. Check referenced component and utility paths exist.
5. Verify no AppSecret, database password, or merchant secret appears in tracked files.

### Task 3: Run regression verification and review

**Files:**
- Test: `apps/api/src/**/*.spec.ts`
- Test: `apps/api/test/**/*.e2e-spec.ts`

**Steps:**
1. Run API unit tests.
2. Run API build.
3. Run shared and admin builds if affected by workspace build.
4. Review the scoped diff against this plan.
5. Request an independent code review and resolve important findings.

### Task 4: Commit and deploy the backend

**Files:**
- Commit only phase-one source, tests, configuration, and plan documents.

**Steps:**
1. Confirm CloudRun port `3000`, health endpoint, required environment variables, and public access.
2. Stage only scoped files; exclude outputs and ignored secrets.
3. Commit with a focused message.
4. Push `main` to `origin` to trigger the CloudRun pipeline.
5. Poll the public health endpoint until the new revision is active.
6. Probe invalid `wx-login` and confirm the old placeholder error is gone.

### Task 5: Prepare real-device acceptance

**Files:**
- No production edits unless validation reveals an issue.

**Steps:**
1. Open `apps/miniprogram` in WeChat Developer Tools.
2. Compile with the new AppID and CloudBase environment.
3. Verify `wx.login` succeeds and JWT is stored.
4. Verify phone authorization and house matching.
5. Verify bills load and Mock payment still completes.
6. Record any external console gaps, including privacy agreement and phone-number capability.
