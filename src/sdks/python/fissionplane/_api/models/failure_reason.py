from enum import Enum


class FailureReason(str, Enum):
    DEADLINE_EXPIRED = "deadline_expired"
    DRAINED_WITHOUT_CAPTURE = "drained_without_capture"
    NEVER_ACKNOWLEDGED = "never_acknowledged"
    NODE_LOST = "node_lost"
    RESTORE_FAILED = "restore_failed"
    SNAPSHOT_EXPIRED = "snapshot_expired"
    SNAPSHOT_UPLOAD_ABANDONED = "snapshot_upload_abandoned"

    def __str__(self) -> str:
        return str(self.value)
