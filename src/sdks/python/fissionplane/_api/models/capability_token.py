from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

T = TypeVar("T", bound="CapabilityToken")


@_attrs_define
class CapabilityToken:
    """
    Attributes:
        token (str): The bearer credential for the sandbox data plane. Carries
            the sandbox ID, epoch, scope, and expiry; verified by the
            gateway and again by the owning node. Never logged.
        expires_at (datetime.datetime):
        epoch (int): The epoch the token was minted against.
        ports (list[int] | None | Unset): The port scope, when narrowed. Null means the full scope.
    """

    token: str
    expires_at: datetime.datetime
    epoch: int
    ports: list[int] | None | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        token = self.token

        expires_at = self.expires_at.isoformat()

        epoch = self.epoch

        ports: list[int] | None | Unset
        if isinstance(self.ports, Unset):
            ports = UNSET
        elif isinstance(self.ports, list):
            ports = self.ports

        else:
            ports = self.ports

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "token": token,
                "expires_at": expires_at,
                "epoch": epoch,
            }
        )
        if ports is not UNSET:
            field_dict["ports"] = ports

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        token = d.pop("token")

        expires_at = datetime.datetime.fromisoformat(d.pop("expires_at"))

        epoch = d.pop("epoch")

        def _parse_ports(data: object) -> list[int] | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, list):
                    raise TypeError()
                ports_type_0 = cast(list[int], data)

                return ports_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(list[int] | None | Unset, data)

        ports = _parse_ports(d.pop("ports", UNSET))

        capability_token = cls(
            token=token,
            expires_at=expires_at,
            epoch=epoch,
            ports=ports,
        )

        capability_token.additional_properties = d
        return capability_token

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
