# This project's own bug corpus

One report per bug this project hit while building itself, written in the same format the
author's external corpus uses so a booker treats the two roots identically. This root and the
external one are both booked as cases in a later phase; a report here cites its own fix commit
so that booking has an `about` URI to join a case on, rather than prose alone.

A report is markdown: a title, a one-paragraph statement of what went wrong, a `Reproduces:`
section naming what to run, and a `Fixed by:` line naming the commit that closed it. An open
report carries no `Fixed by:` line yet; once one lands, the report is updated in the same
commit that fixes it, never afterward.
