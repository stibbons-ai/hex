# hex

Daniel's personal agentic assistant: reachable through messaging channels and running document workflows for his bookkeeping.

## Documents

**Intake**:
One incoming email carrying zero or more Documents; the unit the document workflow processes once.
_Avoid_: Mail, job, batch

**Document**:
One file within an Intake that is a PDF or image and not inline decoration (signatures, logos).
_Avoid_: Invoice (as umbrella term), attachment, scan, file

**Document date**:
The date printed on a Document, as opposed to the date it was received.
_Avoid_: Invoice date, received date

**Filing**:
Placing a Document under `YYYY-MM/<Category>/` by its Document date, falling back to the Intake's received date.
_Avoid_: Saving, archiving

**Category**:
The bookkeeping bucket a Document is filed under.
_Avoid_: Type, folder

**ER** (Eingangsrechnung):
Category for incoming invoices and other received documents; currently the only Category.
_Avoid_: Incoming, inbound

**Forwarding**:
Handing an Intake's Documents unchanged to an external bookkeeping system (SevDesk, paperless-ngx).
_Avoid_: Sending, export

**Outbox**:
The staging folder where Filing places Documents until the sync moves them into the Archive.
_Avoid_: Output folder, staging, export

**Archive**:
Daniel's bookkeeping folder in Proton Drive (`Buchhaltung`), the final home of filed Documents.
_Avoid_: Buchhaltung, drive, destination

**Intake report**:
A short message to Daniel's main channel summarising one processed Intake, flagging date fallbacks and failures.
_Avoid_: Notification, alert

**Main channel**:
The one conversation (currently a Slack DM, later Signal) where hex reaches Daniel unprompted.
_Avoid_: Default channel, notification channel
