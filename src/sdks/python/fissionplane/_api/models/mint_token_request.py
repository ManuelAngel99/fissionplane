from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="MintTokenRequest")


@_attrs_define
class MintTokenRequest:
    """
    Attributes:
        ttl_seconds (int | Unset): Requested token lifetime, bounded by the installation's maximum.
        ports (list[int] | Unset): Restrict the token to these ports. Omitted means the full
            scope the caller's credential permits; a scope can only
            narrow, never widen.
    """

    ttl_seconds: int | Unset = UNSET
    ports: list[int] | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        ttl_seconds = self.ttl_seconds

        ports: list[int] | Unset = UNSET
        if not isinstance(self.ports, Unset):
            ports = self.ports

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update({})
        if ttl_seconds is not UNSET:
            field_dict["ttl_seconds"] = ttl_seconds
        if ports is not UNSET:
            field_dict["ports"] = ports

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        ttl_seconds = d.pop("ttl_seconds", UNSET)

        ports = cast(list[int], d.pop("ports", UNSET))

        mint_token_request = cls(
            ttl_seconds=ttl_seconds,
            ports=ports,
        )

        mint_token_request.additional_properties = d
        return mint_token_request

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
