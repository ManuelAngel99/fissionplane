from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.process_log_chunk import ProcessLogChunk


T = TypeVar("T", bound="ProcessLogs")


@_attrs_define
class ProcessLogs:
    """
    Attributes:
        chunks (list[ProcessLogChunk]):
        next_sequence (int):
        running (bool):
        exit_code (int | None | Unset):
        truncated_before (int | Unset):
    """

    chunks: list[ProcessLogChunk]
    next_sequence: int
    running: bool
    exit_code: int | None | Unset = UNSET
    truncated_before: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        chunks = []
        for chunks_item_data in self.chunks:
            chunks_item = chunks_item_data.to_dict()
            chunks.append(chunks_item)

        next_sequence = self.next_sequence

        running = self.running

        exit_code: int | None | Unset
        if isinstance(self.exit_code, Unset):
            exit_code = UNSET
        else:
            exit_code = self.exit_code

        truncated_before = self.truncated_before

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "chunks": chunks,
                "next_sequence": next_sequence,
                "running": running,
            }
        )
        if exit_code is not UNSET:
            field_dict["exit_code"] = exit_code
        if truncated_before is not UNSET:
            field_dict["truncated_before"] = truncated_before

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.process_log_chunk import ProcessLogChunk

        d = dict(src_dict)
        chunks = []
        _chunks = d.pop("chunks")
        for chunks_item_data in _chunks:
            chunks_item = ProcessLogChunk.from_dict(chunks_item_data)

            chunks.append(chunks_item)

        next_sequence = d.pop("next_sequence")

        running = d.pop("running")

        def _parse_exit_code(data: object) -> int | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(int | None | Unset, data)

        exit_code = _parse_exit_code(d.pop("exit_code", UNSET))

        truncated_before = d.pop("truncated_before", UNSET)

        process_logs = cls(
            chunks=chunks,
            next_sequence=next_sequence,
            running=running,
            exit_code=exit_code,
            truncated_before=truncated_before,
        )

        process_logs.additional_properties = d
        return process_logs

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
