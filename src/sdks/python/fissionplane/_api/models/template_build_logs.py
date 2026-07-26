from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.template_build_log_entry import TemplateBuildLogEntry


T = TypeVar("T", bound="TemplateBuildLogs")


@_attrs_define
class TemplateBuildLogs:
    """
    Attributes:
        entries (list[TemplateBuildLogEntry]):
        next_offset (int): Pass as `offset` on the next poll.
    """

    entries: list[TemplateBuildLogEntry]
    next_offset: int
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        entries = []
        for entries_item_data in self.entries:
            entries_item = entries_item_data.to_dict()
            entries.append(entries_item)

        next_offset = self.next_offset

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "entries": entries,
                "next_offset": next_offset,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.template_build_log_entry import TemplateBuildLogEntry

        d = dict(src_dict)
        entries = []
        _entries = d.pop("entries")
        for entries_item_data in _entries:
            entries_item = TemplateBuildLogEntry.from_dict(entries_item_data)

            entries.append(entries_item)

        next_offset = d.pop("next_offset")

        template_build_logs = cls(
            entries=entries,
            next_offset=next_offset,
        )

        template_build_logs.additional_properties = d
        return template_build_logs

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
