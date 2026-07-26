from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.process_log_chunk_stream import ProcessLogChunkStream

T = TypeVar("T", bound="ProcessLogChunk")


@_attrs_define
class ProcessLogChunk:
    """
    Attributes:
        stream (ProcessLogChunkStream):
        sequence (int):
        data (str):
    """

    stream: ProcessLogChunkStream
    sequence: int
    data: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        stream = self.stream.value

        sequence = self.sequence

        data = self.data

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "stream": stream,
                "sequence": sequence,
                "data": data,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        stream = ProcessLogChunkStream(d.pop("stream"))

        sequence = d.pop("sequence")

        data = d.pop("data")

        process_log_chunk = cls(
            stream=stream,
            sequence=sequence,
            data=data,
        )

        process_log_chunk.additional_properties = d
        return process_log_chunk

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
