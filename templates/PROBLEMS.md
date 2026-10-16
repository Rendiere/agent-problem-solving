# Problems

Mission: <one line: the outcome this agent exists for, with its metric>

<!--
One entry per problem. A thread holds at most one active problem.

status: proposed | active | paused | parked | blocked | done | dropped
  proposed  drafted, waiting for the operator to confirm
  active    the one problem this thread is on
  paused    a parent waiting while its side task holds the thread
  parked    set aside with its state written down
  blocked   stuck on something outside the agent; still holds the thread
  done      the done-when was met and the operator confirmed it
  dropped   abandoned, with the operator's say-so

Only the operator moves a problem to active, done or dropped. The agent
proposes, rewords (back to proposed), parks once confirmed, or marks blocked.
Record every change with `aps set`, which stamps the date and writes the
decision log; a hand edit parses, but `aps lint` flags it.

## P1. <short action title>
- status: proposed
- problem: <what is wrong or missing, with no solution in it>
- serves: <the mission metric this moves>
- done when: <a check anyone could run: a number in the data, a screenshot, a sent email>
- rules out: <what waits until this is done>
- thread: <the chat thread it lives in, e.g. topic:1234, dir:~/code/website, or "any">
- parent: <the problem this side task unblocks; leave out otherwise>
- links: <tickets in any tracker, e.g. LIN-12, JIRA-4>
- pending: <frame | enter | switch | park | close | drop | reset | drift> <YYYY-MM-DD>
    frame  waiting on the wording of the problem, before the rest is drafted
    enter  waiting on the whole entry, once the wording is agreed
- confirmed: <YYYY-MM-DD> <what the operator confirmed>
- pushbacks: 0
- corrections: 0
- updated: YYYY-MM-DD
- state: <one line on where it stands; always fill it when parking>
- learned: <one line, written at close>
-->
