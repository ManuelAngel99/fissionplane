from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.file_kind import FileKind
from ..types import UNSET, Unset

T = TypeVar("T", bound="FileInfo")


@_attrs_define
class FileInfo:
    """
    Attributes:
        path (str):
        name (str):
        kind (FileKind):
        size (int):
        mode (str):
        modified_at (datetime.datetime):
        target (str | Unset): Symlink target; absent for other kinds.
    """

    path: str
    name: str
    kind: FileKind
    size: int
    mode: str
    modified_at: datetime.datetime
    target: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        path = self.path

        name = self.name

        kind = self.kind.value

        size = self.size

        mode = self.mode

        modified_at = self.modified_at.isoformat()

        target = self.target

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "path": path,
                "name": name,
                "kind": kind,
                "size": size,
                "mode": mode,
                "modified_at": modified_at,
            }
        )
        if target is not UNSET:
            field_dict["target"] = target

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        path = d.pop("path")

        name = d.pop("name")

        kind = FileKind(d.pop("kind"))

        size = d.pop("size")

        mode = d.pop("mode")

        modified_at = datetime.datetime.fromisoformat(d.pop("modified_at"))

        target = d.pop("target", UNSET)

        file_info = cls(
            path=path,
            name=name,
            kind=kind,
            size=size,
            mode=mode,
            modified_at=modified_at,
            target=target,
        )

        file_info.additional_properties = d
        return file_info

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
