---------------------- MODULE ApprovalInterruptRecovery ----------------------
EXTENDS Naturals

CONSTANTS Fingerprints

VARIABLES
  parentPolicy,
  subagentPolicy,
  phase,
  decision,
  activePolicy,
  hasDenyRule,
  hasAllowRule,
  needsApproval,
  opFingerprint,
  checkpointActive,
  checkpointFingerprint,
  resumedWithFingerprint,
  resumeAccepted

vars == <<
  parentPolicy,
  subagentPolicy,
  phase,
  decision,
  activePolicy,
  hasDenyRule,
  hasAllowRule,
  needsApproval,
  opFingerprint,
  checkpointActive,
  checkpointFingerprint,
  resumedWithFingerprint,
  resumeAccepted
>>

Policies == {"never", "untrusted", "on-request"}
Phases == {"idle", "evaluated", "waiting_approval", "resumed", "completed", "denied"}
Decisions == {"none", "allow", "review", "deny"}
MaybeFingerprints == {"none"} \cup Fingerprints

PolicyRank(p) ==
  CASE p = "never" -> 0
    [] p = "untrusted" -> 1
    [] p = "on-request" -> 2

Init ==
  /\ parentPolicy \in Policies
  /\ subagentPolicy \in {p \in Policies : PolicyRank(p) <= PolicyRank(parentPolicy)}
  /\ phase = "idle"
  /\ decision = "none"
  /\ activePolicy = parentPolicy
  /\ hasDenyRule = FALSE
  /\ hasAllowRule = FALSE
  /\ needsApproval = FALSE
  /\ opFingerprint = "none"
  /\ checkpointActive = FALSE
  /\ checkpointFingerprint = "none"
  /\ resumedWithFingerprint = "none"
  /\ resumeAccepted = FALSE

ConfigureSubagentPolicy(p) ==
  /\ phase = "idle"
  /\ p \in Policies
  /\ IF PolicyRank(p) <= PolicyRank(parentPolicy)
       THEN subagentPolicy' = p
       ELSE UNCHANGED subagentPolicy
  /\ UNCHANGED <<
       parentPolicy, phase, decision, activePolicy, hasDenyRule,
       hasAllowRule, needsApproval, opFingerprint, checkpointActive,
       checkpointFingerprint, resumedWithFingerprint, resumeAccepted
     >>

EvaluateInvocation(useSubagent, denyFlag, allowFlag, needsRev, fp) ==
  /\ phase = "idle"
  /\ useSubagent \in BOOLEAN
  /\ denyFlag \in BOOLEAN
  /\ allowFlag \in BOOLEAN
  /\ needsRev \in BOOLEAN
  /\ fp \in Fingerprints
  /\ LET effPolicy == IF useSubagent THEN subagentPolicy ELSE parentPolicy IN
       /\ activePolicy' = effPolicy
       /\ hasDenyRule' = denyFlag
       /\ hasAllowRule' = allowFlag
       /\ needsApproval' = needsRev
       /\ opFingerprint' = fp
       /\ checkpointActive' = FALSE
       /\ checkpointFingerprint' = "none"
       /\ resumedWithFingerprint' = "none"
       /\ resumeAccepted' = FALSE
       /\ IF denyFlag
            THEN /\ decision' = "deny"
                 /\ phase' = "denied"
            ELSE IF needsRev \/ (effPolicy = "untrusted" /\ ~allowFlag)
                   THEN IF effPolicy = "never"
                          THEN /\ decision' = "deny"
                               /\ phase' = "denied"
                          ELSE /\ decision' = "review"
                               /\ phase' = "evaluated"
                   ELSE /\ decision' = "allow"
                        /\ phase' = "completed"
  /\ UNCHANGED <<parentPolicy, subagentPolicy>>

CreateCheckpointAndInterrupt ==
  /\ phase = "evaluated"
  /\ decision = "review"
  /\ activePolicy /= "never"
  /\ checkpointActive' = TRUE
  /\ checkpointFingerprint' = opFingerprint
  /\ phase' = "waiting_approval"
  /\ UNCHANGED <<
       parentPolicy, subagentPolicy, decision, activePolicy,
       hasDenyRule, hasAllowRule, needsApproval, opFingerprint,
       resumedWithFingerprint, resumeAccepted
     >>

ResumeFromCheckpoint(candidateDecision, candidateFp) ==
  /\ phase = "waiting_approval"
  /\ checkpointActive = TRUE
  /\ candidateDecision \in {"allow", "deny"}
  /\ candidateFp \in Fingerprints
  /\ resumedWithFingerprint' = candidateFp
  /\ checkpointActive' = FALSE
  /\ IF candidateFp /= checkpointFingerprint
       THEN /\ resumeAccepted' = FALSE
            /\ decision' = "deny"
            /\ phase' = "denied"
       ELSE IF candidateDecision = "allow"
              THEN /\ resumeAccepted' = TRUE
                   /\ decision' = "allow"
                   /\ phase' = "resumed"
              ELSE /\ resumeAccepted' = FALSE
                   /\ decision' = "deny"
                   /\ phase' = "denied"
  /\ UNCHANGED <<
       parentPolicy, subagentPolicy, activePolicy, hasDenyRule,
       hasAllowRule, needsApproval, opFingerprint, checkpointFingerprint
     >>

ResetToIdle ==
  /\ phase \in {"completed", "denied", "resumed"}
  /\ phase' = "idle"
  /\ decision' = "none"
  /\ activePolicy' = parentPolicy
  /\ hasDenyRule' = FALSE
  /\ hasAllowRule' = FALSE
  /\ needsApproval' = FALSE
  /\ opFingerprint' = "none"
  /\ checkpointActive' = FALSE
  /\ checkpointFingerprint' = "none"
  /\ resumedWithFingerprint' = "none"
  /\ resumeAccepted' = FALSE
  /\ UNCHANGED <<parentPolicy, subagentPolicy>>

Next ==
  \/ \E p \in Policies : ConfigureSubagentPolicy(p)
  \/ \E useSubagent \in BOOLEAN, denyFlag \in BOOLEAN, allowFlag \in BOOLEAN,
        needsRev \in BOOLEAN, fp \in Fingerprints :
       EvaluateInvocation(useSubagent, denyFlag, allowFlag, needsRev, fp)
  \/ CreateCheckpointAndInterrupt
  \/ \E candidateDecision \in {"allow", "deny"}, candidateFp \in Fingerprints :
       ResumeFromCheckpoint(candidateDecision, candidateFp)
  \/ ResetToIdle

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ parentPolicy \in Policies
  /\ subagentPolicy \in Policies
  /\ phase \in Phases
  /\ decision \in Decisions
  /\ activePolicy \in Policies
  /\ hasDenyRule \in BOOLEAN
  /\ hasAllowRule \in BOOLEAN
  /\ needsApproval \in BOOLEAN
  /\ opFingerprint \in MaybeFingerprints
  /\ checkpointActive \in BOOLEAN
  /\ checkpointFingerprint \in MaybeFingerprints
  /\ resumedWithFingerprint \in MaybeFingerprints
  /\ resumeAccepted \in BOOLEAN

NeverPolicyNeverWaitsForApproval ==
  (activePolicy = "never") => (decision /= "review" /\ phase /= "waiting_approval")

DenyOverridesAllow ==
  (phase /= "idle" /\ hasDenyRule) => (decision = "deny" /\ phase = "denied")

FingerprintMismatchCannotResume ==
  /\ resumeAccepted =>
       (resumedWithFingerprint = checkpointFingerprint /\ checkpointFingerprint /= "none")
  /\ (resumedWithFingerprint /= "none" /\ resumedWithFingerprint /= checkpointFingerprint) =>
       (phase /= "resumed" /\ ~resumeAccepted)

SubagentNeverExceedsParentCeiling ==
  PolicyRank(subagentPolicy) <= PolicyRank(parentPolicy)

=============================================================================
