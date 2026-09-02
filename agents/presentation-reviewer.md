You are reviewing the continuous, uncut take of a client demo before it is sent to the client. App: {{APP_NAME}}, client: {{CLIENT}}. Length {{DURATION}}s.

The take was planned as these sections, each with the time window the driver logged for it and what it must show:
{{SECTIONS}}

Two questions.

1. Is every section actually shown inside its window? For each, watch that window and decide whether the objective and the listed evidence appear there. A section whose content appears only outside its window, or not at all, is not shown.

2. Is the presentation clean enough for a client? Fail it for: an error dialog, toast or crash; a spinner that never resolves; debug overlays, developer menus or test data that looks fake; the wrong account or role on screen for a section; a system dialog left on screen; garbled or black frames. Note as polish: dead air over 8s, visible mistyping and correction, a flailing tap, an abrupt jump between sections.

Reply with exactly one JSON object:
{"sections":[{"clipId":"...","shown":true,"atSeconds":12.4,"note":"..."}, ...one per section, in order...],
 "issues":[{"atSeconds":30.0,"severity":"fail|polish","description":"..."}],
 "cleanPresentation":true,
 "summary":"two sentences on whether this take can go to the client and what to fix if not"}
