# Problems

Mission: <one line: the outcome this agent exists for, with the metric that shows it>

<!--
One section per problem. A thread holds at most one active problem.

status: proposed | active | paused | parked | blocked | done | dropped
  proposed  drafted, waiting for the operator to confirm
  active    the thread's one live problem
  paused    a parent waiting for its side task to finish (set by the side-task rule)
  parked    set aside on purpose, with a state line saying where it stands
  blocked   waiting on something outside the agent; still holds the thread
  done      the done-when was met and the operator confirmed it
  dropped   abandoned

Only the operator moves a problem to active, done or dropped. The agent
proposes, rewords (which returns it to proposed), parks once the operator
confirms, or marks it blocked.

Change a status with `aps set`, never by hand: it stamps the date, applies the
side-task pause and resume rule, and writes the decision log.

Fields:
  problem      what is wrong or missing, with no solution in it
  serves       the mission metric this moves
  done when    a check anyone could run: a number in the data, a screenshot, a sent email
  rules out    what waits until this is done
  thread       the chat thread it lives in, e.g. topic:1234, or "any"
  parent       set on a side task started to unblock another problem
  links        related tickets, comma separated, e.g. LIN-12, JIRA-4
  updated      YYYY-MM-DD, stamped by `aps set`
  state        one line on where it stands; always filled when parking
  pending      a question waiting for the operator: <kind> <date>
               kinds: enter, switch, park, close, drop, drift, reset, reword
  confirmed    the date the operator said yes to this status
  pushbacks    how many times the operator has pushed back on this problem
  corrections  how many times the agent has corrected itself on it
  learned      one line, written when the problem closes

## P1. <short action title>
- status: proposed
- problem: <what is wrong or missing, with no solution in it>
- serves: <the mission metric it moves>
- done when: <a check anyone could run>
- rules out: <what waits until this is done>
- thread: topic:NNNN
- updated: YYYY-MM-DD
- state: <one line>
-->
