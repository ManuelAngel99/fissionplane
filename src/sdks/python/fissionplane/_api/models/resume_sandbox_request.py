from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="ResumeSandboxRequest")


@_attrs_define
class ResumeSandboxRequest:
    """
    Attributes:
        deadline_seconds (int | Unset): Lease for the resumed instance, from now. Omitted means the default lease.
    """

    deadline_seconds: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        deadline_seconds = self.deadline_seconds

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if deadline_seconds is not UNSET:
            field_dict["deadline_seconds"] = deadline_seconds

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        deadline_seconds = d.pop("deadline_seconds", UNSET)

        resume_sandbox_request = cls(
            deadline_seconds=deadline_seconds,
        )

        resume_sandbox_request.additional_properties = d
        return resume_sandbox_request

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
