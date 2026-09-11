## ADDED Requirements

### Requirement: Global upload task status
The system SHALL show selected totals, fingerprint progress, per-file transfer outcomes and separate parsing status in a global task panel that survives in-app navigation.

#### Scenario: Large folder upload
- **WHEN** a user confirms 446 PDF files
- **THEN** the panel shows all 446 items and starts no more than three concurrent transfers
- **AND** successful HTTP uploads are shown as received rather than assumed parsed

### Requirement: Duplicate preflight and rejection
The system SHALL reject same-content same-type files within the selected batch and the authorized knowledge base before transferring their bodies; final server checks SHALL remain authoritative and SHALL NOT change existing creation timestamps.

#### Scenario: Renamed existing PDF
- **WHEN** a selected PDF has the same MD5 and type as an existing non-failed document
- **THEN** it is marked duplicate with the existing name and no file body is uploaded

#### Scenario: Same name with different content
- **WHEN** two PDFs have the same name but distinct content hashes
- **THEN** name equality alone does not reject either file

#### Scenario: Preflight unavailable or unauthorized
- **WHEN** fingerprint preflight fails or the user cannot upload to that KB
- **THEN** the batch sends no file bodies and exposes a retryable or authorization error

### Requirement: Cancellation and recovery
The system SHALL stop dispatching files when cancelled, abort active HTTP requests, preserve outcomes, and allow retry through preflight. It SHALL warn before unloading an active transfer and stop work on account/space changes.

#### Scenario: Cancel during transfer
- **WHEN** the user stops a batch with active and waiting files
- **THEN** waiting files are cancelled and active requests are aborted
- **AND** the UI warns that an aborted request may already have been received

### Requirement: Scoped rollback
The system SHALL let the user request deletion of only the documents newly created by the batch, excluding duplicate matches, and SHALL verify asynchronous deletion before reporting completion.

#### Scenario: Mixed duplicate and successful files
- **WHEN** the user revokes a batch containing duplicate matches and newly created files
- **THEN** only new document IDs are submitted for deletion, and failures remain visible
