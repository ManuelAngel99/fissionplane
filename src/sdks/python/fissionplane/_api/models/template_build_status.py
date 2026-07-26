from enum import Enum


class TemplateBuildStatus(str, Enum):
    BUILDING = "building"
    FAILED = "failed"
    QUEUED = "queued"
    SUCCEEDED = "succeeded"

    def __str__(self) -> str:
        return str(self.value)
