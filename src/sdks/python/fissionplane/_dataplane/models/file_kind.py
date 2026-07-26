from enum import Enum


class FileKind(str, Enum):
    DIRECTORY = "directory"
    FILE = "file"
    OTHER = "other"
    SYMLINK = "symlink"

    def __str__(self) -> str:
        return str(self.value)
