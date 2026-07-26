from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.port_visibility import PortVisibility

T = TypeVar("T", bound="PortExposure")


@_attrs_define
class PortExposure:
    """
    Attributes:
        port (int):
        visibility (PortVisibility): `private`: reachable at the port's hostname with a capability
            token whose scope permits it — the default for every port.
            `public`: anonymous traffic is admitted to this one tenant
            application port. Reserved platform ports can never be public.
        url (str): The port's public URL, `https://<port>-<sandbox_id>.<domain>`.
    """

    port: int
    visibility: PortVisibility
    url: str
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        port = self.port

        visibility = self.visibility.value

        url = self.url

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "port": port,
                "visibility": visibility,
                "url": url,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        port = d.pop("port")

        visibility = PortVisibility(d.pop("visibility"))

        url = d.pop("url")

        port_exposure = cls(
            port=port,
            visibility=visibility,
            url=url,
        )

        port_exposure.additional_properties = d
        return port_exposure

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
