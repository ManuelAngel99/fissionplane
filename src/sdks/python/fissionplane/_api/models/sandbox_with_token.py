from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

if TYPE_CHECKING:
    from ..models.capability_token import CapabilityToken
    from ..models.sandbox import Sandbox


T = TypeVar("T", bound="SandboxWithToken")


@_attrs_define
class SandboxWithToken:
    """A sandbox together with a capability token for its current epoch.

    Attributes:
        sandbox (Sandbox):
        token (CapabilityToken):
    """

    sandbox: Sandbox
    token: CapabilityToken
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        sandbox = self.sandbox.to_dict()

        token = self.token.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "sandbox": sandbox,
                "token": token,
            }
        )

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.capability_token import CapabilityToken
        from ..models.sandbox import Sandbox

        d = dict(src_dict)
        sandbox = Sandbox.from_dict(d.pop("sandbox"))

        token = CapabilityToken.from_dict(d.pop("token"))

        sandbox_with_token = cls(
            sandbox=sandbox,
            token=token,
        )

        sandbox_with_token.additional_properties = d
        return sandbox_with_token

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
