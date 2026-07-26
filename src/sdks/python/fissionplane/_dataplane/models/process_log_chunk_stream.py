from enum import Enum


class ProcessLogChunkStream(str, Enum):
    STDERR = "stderr"
    STDOUT = "stdout"

    def __str__(self) -> str:
        return str(self.value)
