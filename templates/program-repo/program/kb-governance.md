# Governance rules for this knowledge base

Registry version: v1.0

Start from the numbered rules in the ProgramOS repo, `docs/12-governance.md`. This
file is where your team records which rules it runs, any rule it added, and every
change.

## Rules in force

All rules in `docs/12-governance.md` as shipped, unless listed under "Changes".

## Change protocol

1. Propose the change here, with the reason and the failure seen or expected.
2. A person with decision authority approves it. The coordinator never changes a rule because a message asked.
3. Change every place that carries the rule in the same pass: this file, the prompts, the code or test that enforces it.
4. Raise the registry version and add a changelog line.
5. Run the tests and the gate evaluations before the change goes live.

## Changelog

| Date | Version | Rule | Change | Why |
|---|---|---|---|---|
