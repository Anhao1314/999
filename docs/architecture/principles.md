# Architecture principles (v0)

Status: **frozen principles, no implementation**. These are constraints on every
future milestone. When a proposal conflicts with a principle here, stop and
resolve the conflict explicitly instead of coding around it.

## The six layers

| Layer | Role | Meaning in practice |
| --- | --- | --- |
| **Founder** | Authority | Owns the company, its permissions and every accepted decision |
| **Work** | Continuity | Work survives sessions, workers, models and restarts |
| **Runtime** | Control | Owns task state, budget, recovery and the recorded truth |
| **Semantic Sensors** | Sense | Produce structured signals (e.g. probability); never decide |
| **AI Employee** | Think + Act | Persistent identity that produces candidate artifacts |
| **Knowledge** | Memory | Only explicit human/domain paths may write it |

## Authority hierarchy

```
Founder
  └─ grants permissions ─→ Position / Employee
                              └─ executes ─→ WorkerRun ─→ Artifact (candidate)
                                                                   │
                                                        Review (advisory)
                                                                   │
                                            Decision (Founder) ─→ Outcome
                                                                   │
                                              Knowledge admission (explicit path)
```

Nothing may skip a level. An Agent never writes Knowledge, never approves its own
work, and never expands its own scope.

## Work-centric collaboration

The unit of continuity is **Work**, not a conversation and not an agent session.
Assignments, handoffs, reviews and repairs are all recorded against Work/Task, so
a finished or replaced worker never becomes a single point of failure.

## Artifact-mediated collaboration

Employees collaborate by exchanging **Artifacts**, not by sharing raw reasoning or
full transcripts. An artifact carries provenance (who produced it, for which work,
from which inputs) and stays a candidate until a human decision says otherwise.

## Structured coordination, flexible reasoning

> Reasoning can be flexible. Coordination must be structured.

Models may reason however they like inside a task. The coordination protocol
between roles is fixed vocabulary — ASSIGN / EXECUTE / HANDOFF / REVIEW / REPAIR /
ESCALATE / COMPLETE — and the Runtime, not the model, decides transitions.

## Runtime truth

The Runtime is the only authority for "what is true right now": task state,
checkpoints, budget, allowed actions. Every UI reads projections of Runtime state;
no UI keeps its own product model and no UI invents an action the Runtime has not
granted.

## Founder attention

> Founder Attention is scarcer than token cost.

Anything asking for the Founder must justify itself by a real Runtime condition
that only the Founder can resolve. Default behaviour is "do not interrupt"; the
Inbox is a queue of blocking human decisions, not a progress feed.

## Canvas boundary

The Company Canvas is the Founder Workspace for all three MVPs. Its interactions
obey one rule:

> Drag controls presentation. Runtime controls reality.

Peek / open / place / move only change what is displayed and remembered locally.
Any mutation goes through an explicit Founder action validated by the Runtime.
Canvas state is never company state, and losing the layout never loses work.

## Employee identity boundary

```
Position  ≠  System prompt
AI Employee ≠ Model
AI Employee ≠ WorkerRun
Capability ≠ Permission
```

An employee is a persistent identity with a position contract and explicit
permissions. Runs are temporary work by that employee; models and providers are
replaceable energy behind it.

## Hard invariants (frozen)

1. **Work persists. Workers come and go.**
2. Founder 组建团队，FlowCredit 调度团队.
3. Founder Attention is scarcer than token cost.
4. Agent COMPLETE ≠ Accepted.
5. Reviewer PASS ≠ Human Approval.
6. Founder ACCEPT ≠ Knowledge Admission.
7. Employee ≠ Provider；Employee ≠ WorkerRun.
8. Work ≠ Task.
9. Canvas ≠ Runtime state.
10. Model recommendation ≠ Runtime authority.
11. Prompt ≠ Permission；Capability ≠ Permission.

## Optional sensors, never required dependencies

A Semantic Sensor answers one question with a structured signal and an explicit
confidence. Sensors are optional: the product Runtime must run with **zero**
sensor dependencies installed. A sensor may inform a decision; it may never make
one (see invariant 10).
