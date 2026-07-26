from enum import Enum


class KillProcessSignal(str, Enum):
    SIGHUP = "SIGHUP"
    SIGINT = "SIGINT"
    SIGKILL = "SIGKILL"
    SIGTERM = "SIGTERM"

    def __str__(self) -> str:
        return str(self.value)
