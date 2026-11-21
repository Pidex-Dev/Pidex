------------------------- MODULE RpcOutboxSseReplay -------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS MaxSeq, Clients

VARIABLES
  lowWatermark,
  highWatermark,
  outbox,
  publishedLog,
  subActive,
  startCursor,
  subCursor,
  ackCursor,
  delivered,
  lastAttemptCursor,
  lastAttemptLow,
  lastAttemptHigh,
  lastAttemptResult

vars == <<
  lowWatermark,
  highWatermark,
  outbox,
  publishedLog,
  subActive,
  startCursor,
  subCursor,
  ackCursor,
  delivered,
  lastAttemptCursor,
  lastAttemptLow,
  lastAttemptHigh,
  lastAttemptResult
>>

CursorValid(cursor, low, high) ==
  cursor <= high /\ (low = 0 \/ cursor >= low - 1)

Init ==
  /\ lowWatermark = 0
  /\ highWatermark = 0
  /\ outbox = {}
  /\ publishedLog = <<>>
  /\ subActive = [c \in Clients |-> FALSE]
  /\ startCursor = [c \in Clients |-> 0]
  /\ subCursor = [c \in Clients |-> 0]
  /\ ackCursor = [c \in Clients |-> 0]
  /\ delivered = [c \in Clients |-> <<>>]
  /\ lastAttemptCursor = [c \in Clients |-> 0]
  /\ lastAttemptLow = [c \in Clients |-> 0]
  /\ lastAttemptHigh = [c \in Clients |-> 0]
  /\ lastAttemptResult = [c \in Clients |-> "NONE"]

PublishEvent ==
  /\ highWatermark < MaxSeq
  /\ LET nextSeq == highWatermark + 1 IN
       /\ highWatermark' = nextSeq
       /\ lowWatermark' = IF lowWatermark = 0 THEN 1 ELSE lowWatermark
       /\ outbox' = outbox \cup {nextSeq}
       /\ publishedLog' = Append(publishedLog, nextSeq)
  /\ UNCHANGED <<
       subActive, startCursor, subCursor, ackCursor, delivered,
       lastAttemptCursor, lastAttemptLow, lastAttemptHigh, lastAttemptResult
     >>

TrimRetention ==
  /\ lowWatermark > 0
  /\ lowWatermark < highWatermark
  /\ outbox' = outbox \ {lowWatermark}
  /\ lowWatermark' = lowWatermark + 1
  /\ UNCHANGED <<
       highWatermark, publishedLog, subActive, startCursor, subCursor,
       ackCursor, delivered, lastAttemptCursor, lastAttemptLow,
       lastAttemptHigh, lastAttemptResult
     >>

Subscribe(c, after) ==
  /\ ~subActive[c]
  /\ after \in 0..(MaxSeq + 1)
  /\ lastAttemptCursor' = [lastAttemptCursor EXCEPT ![c] = after]
  /\ lastAttemptLow' = [lastAttemptLow EXCEPT ![c] = lowWatermark]
  /\ lastAttemptHigh' = [lastAttemptHigh EXCEPT ![c] = highWatermark]
  /\ IF CursorValid(after, lowWatermark, highWatermark)
       THEN /\ subActive' = [subActive EXCEPT ![c] = TRUE]
            /\ startCursor' = [startCursor EXCEPT ![c] = after]
            /\ subCursor' = [subCursor EXCEPT ![c] = after]
            /\ ackCursor' = [ackCursor EXCEPT ![c] = after]
            /\ delivered' = [delivered EXCEPT ![c] = <<>>]
            /\ lastAttemptResult' = [lastAttemptResult EXCEPT ![c] = "OK"]
       ELSE /\ lastAttemptResult' = [lastAttemptResult EXCEPT ![c] = "CURSOR_EXPIRED"]
            /\ UNCHANGED <<subActive, startCursor, subCursor, ackCursor, delivered>>
  /\ UNCHANGED <<lowWatermark, highWatermark, outbox, publishedLog>>

DeliverNext(c) ==
  /\ subActive[c]
  /\ subCursor[c] < highWatermark
  /\ (subCursor[c] + 1) \in outbox
  /\ LET nextSeq == subCursor[c] + 1 IN
       /\ subCursor' = [subCursor EXCEPT ![c] = nextSeq]
       /\ delivered' = [delivered EXCEPT ![c] = Append(@, nextSeq)]
  /\ UNCHANGED <<
       lowWatermark, highWatermark, outbox, publishedLog, subActive,
       startCursor, ackCursor, lastAttemptCursor, lastAttemptLow,
       lastAttemptHigh, lastAttemptResult
     >>

Ack(c, seq) ==
  /\ subActive[c]
  /\ seq \in ackCursor[c]..highWatermark
  /\ ackCursor' = [ackCursor EXCEPT ![c] = seq]
  /\ UNCHANGED <<
       lowWatermark, highWatermark, outbox, publishedLog, subActive,
       startCursor, subCursor, delivered, lastAttemptCursor,
       lastAttemptLow, lastAttemptHigh, lastAttemptResult
     >>

Reconnect(c, lastSeenSeq) ==
  /\ lastSeenSeq \in 0..(MaxSeq + 1)
  /\ lastAttemptCursor' = [lastAttemptCursor EXCEPT ![c] = lastSeenSeq]
  /\ lastAttemptLow' = [lastAttemptLow EXCEPT ![c] = lowWatermark]
  /\ lastAttemptHigh' = [lastAttemptHigh EXCEPT ![c] = highWatermark]
  /\ IF CursorValid(lastSeenSeq, lowWatermark, highWatermark)
       THEN /\ subActive' = [subActive EXCEPT ![c] = TRUE]
            /\ startCursor' = [startCursor EXCEPT ![c] = lastSeenSeq]
            /\ subCursor' = [subCursor EXCEPT ![c] = lastSeenSeq]
            /\ ackCursor' = [ackCursor EXCEPT ![c] =
                 IF ackCursor[c] > lastSeenSeq THEN ackCursor[c] ELSE lastSeenSeq]
            /\ delivered' = [delivered EXCEPT ![c] = <<>>]
            /\ lastAttemptResult' = [lastAttemptResult EXCEPT ![c] = "OK"]
       ELSE /\ subActive' = [subActive EXCEPT ![c] = FALSE]
            /\ lastAttemptResult' = [lastAttemptResult EXCEPT ![c] = "CURSOR_EXPIRED"]
            /\ UNCHANGED <<startCursor, subCursor, ackCursor, delivered>>
  /\ UNCHANGED <<lowWatermark, highWatermark, outbox, publishedLog>>

Unsubscribe(c) ==
  /\ subActive[c]
  /\ subActive' = [subActive EXCEPT ![c] = FALSE]
  /\ UNCHANGED <<
       lowWatermark, highWatermark, outbox, publishedLog, startCursor,
       subCursor, ackCursor, delivered, lastAttemptCursor, lastAttemptLow,
       lastAttemptHigh, lastAttemptResult
     >>

Next ==
  \/ PublishEvent
  \/ TrimRetention
  \/ \E c \in Clients :
       \/ \E after \in 0..(MaxSeq + 1) : Subscribe(c, after)
       \/ DeliverNext(c)
       \/ \E seq \in 0..MaxSeq : Ack(c, seq)
       \/ \E lastSeenSeq \in 0..(MaxSeq + 1) : Reconnect(c, lastSeenSeq)
       \/ Unsubscribe(c)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ lowWatermark \in 0..MaxSeq
  /\ highWatermark \in 0..MaxSeq
  /\ outbox \subseteq (1..MaxSeq)
  /\ Len(publishedLog) \in 0..MaxSeq
  /\ \A i \in 1..Len(publishedLog) : publishedLog[i] \in 1..MaxSeq
  /\ subActive \in [Clients -> BOOLEAN]
  /\ startCursor \in [Clients -> 0..MaxSeq]
  /\ subCursor \in [Clients -> 0..MaxSeq]
  /\ ackCursor \in [Clients -> 0..MaxSeq]
  /\ \A c \in Clients :
       /\ Len(delivered[c]) \in 0..MaxSeq
       /\ \A i \in 1..Len(delivered[c]) : delivered[c][i] \in 1..MaxSeq
  /\ lastAttemptCursor \in [Clients -> 0..(MaxSeq + 1)]
  /\ lastAttemptLow \in [Clients -> 0..MaxSeq]
  /\ lastAttemptHigh \in [Clients -> 0..MaxSeq]
  /\ lastAttemptResult \in [Clients -> {"NONE", "OK", "CURSOR_EXPIRED"}]

MonotonicOutbox ==
  /\ Len(publishedLog) = highWatermark
  /\ \A i \in 1..Len(publishedLog) : publishedLog[i] = i
  /\ (highWatermark = 0) => (lowWatermark = 0 /\ outbox = {})
  /\ (highWatermark > 0) =>
       (lowWatermark \in 1..highWatermark /\
        outbox = {s \in 1..MaxSeq : s >= lowWatermark /\ s <= highWatermark})

NoGapDelivery ==
  \A c \in Clients :
    /\ \A i \in 1..Len(delivered[c]) : delivered[c][i] = startCursor[c] + i
    /\ \A i \in 1..(Len(delivered[c]) - 1) : delivered[c][i + 1] = delivered[c][i] + 1
    /\ subCursor[c] = startCursor[c] + Len(delivered[c])

AckNeverExceedsHighWatermark ==
  \A c \in Clients : ackCursor[c] <= highWatermark

ExpiredCursorRejected ==
  \A c \in Clients :
    /\ (lastAttemptResult[c] = "CURSOR_EXPIRED") =>
         ~CursorValid(lastAttemptCursor[c], lastAttemptLow[c], lastAttemptHigh[c])
    /\ (lastAttemptResult[c] = "OK") =>
         CursorValid(lastAttemptCursor[c], lastAttemptLow[c], lastAttemptHigh[c])

=============================================================================
