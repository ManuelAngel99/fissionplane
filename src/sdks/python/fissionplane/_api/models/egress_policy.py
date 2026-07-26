from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="EgressPolicy")


@_attrs_define
class EgressPolicy:
    """Egress allow and deny lists, fixed at create: policy is part of
    the sandbox's identity, not mutable state a caller can widen
    after the occupant is running. Entries are hostnames or CIDR
    blocks; deny takes precedence.

        Attributes:
            allow (list[str] | Unset):
            deny (list[str] | Unset):
    """

    allow: list[str] | Unset = UNSET
    deny: list[str] | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        allow: list[str] | Unset = UNSET
        if not isinstance(self.allow, Unset):
            allow = self.allow

        deny: list[str] | Unset = UNSET
        if not isinstance(self.deny, Unset):
            deny = self.deny

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if allow is not UNSET:
            field_dict["allow"] = allow
        if deny is not UNSET:
            field_dict["deny"] = deny

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        allow = cast(list[str], d.pop("allow", UNSET))

        deny = cast(list[str], d.pop("deny", UNSET))

        egress_policy = cls(
            allow=allow,
            deny=deny,
        )

        egress_policy.additional_properties = d
        return egress_policy

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
