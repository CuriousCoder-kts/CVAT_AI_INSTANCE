/**
 * User-facing copy for the annotation correction log.
 *
 * Avoid "Acceptance" / "Accept" / "BEFORE|AFTER" — they collide with CVAT's
 * job stage "acceptance" and sound like approving a job, not logging a frame edit.
 *
 * Mental model (lele-style + GitHub PR):
 * - List page = navigator (find a session)
 * - Review panel = summary + primary CTA onto canvas
 * - Job canvas + original overlay = where you actually see the change
 */
export const CORRECTION_COPY = {
    nav: 'Corrections',
    pageTitleGlobal: 'Correction sessions',
    pageTitleJob: (jobId: number | string) => `Job #${jobId} correction sessions`,
    toolbarLabel: 'Correct',
    toolbarTipIdle: 'Start a correction session: lock originals → edit any frames → Save session',
    toolbarTipActive: 'Correction session in progress — finish on the bottom bar',
    toolbarTipReview: (id: number) => `Viewing correction session #${id}`,
    startLocked: (frame: number, shapes: number) => (
        `Session started on frame #${frame} (${shapes} shapes locked). Edit freely; visit other frames to include them, then Save session.`
    ),
    startBusy: 'A correction session is already open — use the bottom bar to Save or Cancel',
    frameLocked: (frame: number) => `Frame #${frame} original locked into this session`,
    reviewLoaded: (id: number) => (
        `Opened correction session #${id}. Original overlay is on — orange dashed = before.`
    ),
    reviewLoadFail: (id: string | number) => `Failed to load correction session #${id}`,
    sessionTitleCreate: (frames: number) => (
        frames <= 1 ? 'Correction session' : `Correction session · ${frames} frames`
    ),
    sessionSubCreate: (shapes: number, frames: number) => (
        frames <= 1
            ? `Original locked (${shapes} shapes). Edit, Save annotations if needed, then Save session.`
            : `${frames} frames locked (${shapes} shapes total). Continue editing, then Save session once.`
    ),
    showOriginal: 'Show original',
    hideOriginal: 'Hide original',
    showOriginalOverlay: 'Show original overlay',
    hideOriginalOverlay: 'Hide original overlay',
    originalOverlayTip: 'Orange dashed = original. Current annotations are dimmed while overlay is on.',
    overlayEmpty: (frame: number) => (
        `Original on frame #${frame} had no drawable shapes — overlay is empty (this session added new objects).`
    ),
    overlayOn: (count: number, frame: number) => (
        `Showing ${count} original shape(s) on frame #${frame} (orange dashed; current dimmed)`
    ),
    cancel: 'Cancel',
    saveCorrection: 'Save session',
    saved: (id: number, headline: string) => `Session #${id} saved · ${headline}`,
    saveFail: (detail: string) => `Failed to save correction session: ${detail}`,
    frameMismatch: (beforeFrame: number) => (
        `Original is on frame #${beforeFrame}. Switch back to that frame to save the correction.`
    ),
    savedAnnotations: 'Annotations saved (corrected result kept on the job)',
    afterCaptureFail: 'Failed to capture corrected annotations',
    sessionTitleReview: (id: number) => `Correction session #${id}`,
    sessionSubReview: 'Canvas shows the corrected result. Orange dashed overlay = original.',
    changeDetails: 'Change details',
    jobList: 'Session list',
    done: 'Done',
    notePlaceholder: 'Optional session note…',
    howToTitle: 'How to log a correction session',
    howToInfoJob: 'Open the job, click Correct on the toolbar, edit one or more frames, then Save session.',
    howToSteps: [
        'Open a Job on the Task you are reviewing',
        'Click Correct — starts a session and locks the current frame original',
        'Edit any frames (each new frame is locked on first visit)',
        'Click Save session once on the bottom bar',
    ] as const,
    howToTip: 'Later: pick a session in Corrections → Review on canvas to compare with the original overlay.',
    deleteTitle: 'Delete correction session',
    deleteContent: (id: number) => `Delete correction session #${id}? This cannot be undone.`,
    deleteOk: 'Delete',
    deleted: 'Session deleted',
    taskFilterPlaceholder: 'Filter by task name or ID',
    taskFilterEmpty: 'No matching tasks',
    taskGroupTitle: (taskId: number, n: number, name?: string) => {
        const count = `${n} session${n === 1 ? '' : 's'}`;
        if (name && !name.startsWith('Task #')) {
            return `${name} · ${count}`;
        }
        return `Task #${taskId} · ${count}`;
    },
    sessionRowTitle: (id: number) => `Session #${id}`,
    sessionNoSummary: 'No object changes',
    sessionCount: (n: number) => `${n} session${n === 1 ? '' : 's'}`,
    reviewOnCanvas: 'Review on canvas',
    reviewPanelEmptyTitle: 'Select a session',
    reviewPanelEmptyHint: 'Choose a session on the left to inspect changes, then open it on the job canvas.',
    reviewPanelMissing: 'Session not found on this page.',
    reviewFramesLabel: 'Frames',
    reviewChangesLabel: 'Object changes',
    reviewNoObjectDiff: 'No object-level differences.',
    jumpToFrame: 'Open on job',
    deleteRecord: 'Delete',
    loadFail: (status: string, detail: string) => (
        `Failed to load correction sessions${status}: ${detail}`
    ),
    exportCsv: 'Export CSV',
    exportCsvTip: 'Download session summary (+ object changes) for the current filter',
    exportCsvEmpty: 'No correction sessions to export',
    exportCsvDone: (sessions: number, objects: number) => (
        objects
            ? `Exported ${sessions} session(s) and ${objects} object change(s)`
            : `Exported ${sessions} session(s)`
    ),
    exportCsvFail: (detail: string) => `Failed to export CSV: ${detail}`,
    compareTitle: (id: number | string) => `Correction session #${id}`,
    originalJson: 'Original JSON',
    correctedJson: 'Corrected JSON',
    compareTip: 'Review on canvas opens the job with original overlay on (orange dashed).',
    backToJob: 'Back to Job',
} as const;
