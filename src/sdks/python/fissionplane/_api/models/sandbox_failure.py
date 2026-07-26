from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.failure_reason import FailureReason
from ..types import UNSET, Unset

T = TypeVar("T", bound="SandboxFailure")


@_attrs_define
class SandboxFailure:
    """Present exactly when `state` is `failed`.

    Attributes:
        reason (FailureReason): Enumerated cause recorded when a sandbox ends as `failed`.
        recoverable (bool): Whether issuing the failed request again would plausibly work.
        detail (str | Unset): Free text expanding on the reason.
    """

    reason: FailureReason
    recoverable: bool
    detail: str | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        reason = self.reason.value

        recoverable = self.recoverable

        detail = self.detail

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "reason": reason,
                "recoverable": recoverable,
            }
        )
        if detail is not UNSET:
            field_dict["detail"] = detail

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        reason = FailureReason(d.pop("reason"))

        recoverable = d.pop("recoverable")

        detail = d.pop("detail", UNSET)

        sandbox_failure = cls(
            reason=reason,
            recoverable=recoverable,
            detail=detail,
        )

        sandbox_failure.additional_properties = d
        return sandbox_failure

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
