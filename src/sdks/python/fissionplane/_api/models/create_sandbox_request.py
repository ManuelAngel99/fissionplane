from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.create_sandbox_request_metadata import CreateSandboxRequestMetadata
    from ..models.egress_policy import EgressPolicy


T = TypeVar("T", bound="CreateSandboxRequest")


@_attrs_define
class CreateSandboxRequest:
    """
    Attributes:
        template (str): A template alias or artifact ID. Aliases resolve at admission time.
        name (str | Unset): Tenant-assigned sandbox name, unique within an organisation.
        metadata (CreateSandboxRequestMetadata | Unset): Tenant key-value metadata, indexed for list filtering.
        deadline_seconds (int | Unset): Requested lease length, from now. Bounded by the
            installation's maximum; omitted means the default lease.
        egress (EgressPolicy | Unset): Egress allow and deny lists, fixed at create: policy is part of
            the sandbox's identity, not mutable state a caller can widen
            after the occupant is running. Entries are hostnames or CIDR
            blocks; deny takes precedence.
    """

    template: str
    name: str | Unset = UNSET
    metadata: CreateSandboxRequestMetadata | Unset = UNSET
    deadline_seconds: int | Unset = UNSET
    egress: EgressPolicy | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        template = self.template

        name = self.name

        metadata: dict[str, Any] | Unset = UNSET
        if not isinstance(self.metadata, Unset):
            metadata = self.metadata.to_dict()

        deadline_seconds = self.deadline_seconds

        egress: dict[str, Any] | Unset = UNSET
        if not isinstance(self.egress, Unset):
            egress = self.egress.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "template": template,
            }
        )
        if name is not UNSET:
            field_dict["name"] = name
        if metadata is not UNSET:
            field_dict["metadata"] = metadata
        if deadline_seconds is not UNSET:
            field_dict["deadline_seconds"] = deadline_seconds
        if egress is not UNSET:
            field_dict["egress"] = egress

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.create_sandbox_request_metadata import CreateSandboxRequestMetadata
        from ..models.egress_policy import EgressPolicy

        d = dict(src_dict)
        template = d.pop("template")

        name = d.pop("name", UNSET)

        _metadata = d.pop("metadata", UNSET)
        metadata: CreateSandboxRequestMetadata | Unset
        if isinstance(_metadata, Unset):
            metadata = UNSET
        else:
            metadata = CreateSandboxRequestMetadata.from_dict(_metadata)

        deadline_seconds = d.pop("deadline_seconds", UNSET)

        _egress = d.pop("egress", UNSET)
        egress: EgressPolicy | Unset
        if isinstance(_egress, Unset):
            egress = UNSET
        else:
            egress = EgressPolicy.from_dict(_egress)

        create_sandbox_request = cls(
            template=template,
            name=name,
            metadata=metadata,
            deadline_seconds=deadline_seconds,
            egress=egress,
        )

        create_sandbox_request.additional_properties = d
        return create_sandbox_request

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
