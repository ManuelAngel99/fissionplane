from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.resources import Resources


T = TypeVar("T", bound="Template")


@_attrs_define
class Template:
    """
    Attributes:
        template_id (str): Canonical FissionPlane resource identifier: 24 characters from the
            lowercase alphanumeric NanoID alphabet (approximately 124 bits of
            entropy). IDs owned by external systems and content digests use their
            own schemas instead.
        artifact_id (str): Immutable lowercase SHA-256 content digest.
        created_at (datetime.datetime):
        alias (str | Unset): Mutable, human-readable template alias.
        description (str | Unset): Trimmed human-readable resource description.
        resources (Resources | Unset): The compute shape, set by the template artifact.
    """

    template_id: str
    artifact_id: str
    created_at: datetime.datetime
    alias: str | Unset = UNSET
    description: str | Unset = UNSET
    resources: Resources | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        template_id = self.template_id

        artifact_id = self.artifact_id

        created_at = self.created_at.isoformat()

        alias = self.alias

        description = self.description

        resources: dict[str, Any] | Unset = UNSET
        if not isinstance(self.resources, Unset):
            resources = self.resources.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "template_id": template_id,
                "artifact_id": artifact_id,
                "created_at": created_at,
            }
        )
        if alias is not UNSET:
            field_dict["alias"] = alias
        if description is not UNSET:
            field_dict["description"] = description
        if resources is not UNSET:
            field_dict["resources"] = resources

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.resources import Resources

        d = dict(src_dict)
        template_id = d.pop("template_id")

        artifact_id = d.pop("artifact_id")

        created_at = datetime.datetime.fromisoformat(d.pop("created_at"))

        alias = d.pop("alias", UNSET)

        description = d.pop("description", UNSET)

        _resources = d.pop("resources", UNSET)
        resources: Resources | Unset
        if isinstance(_resources, Unset):
            resources = UNSET
        else:
            resources = Resources.from_dict(_resources)

        template = cls(
            template_id=template_id,
            artifact_id=artifact_id,
            created_at=created_at,
            alias=alias,
            description=description,
            resources=resources,
        )

        template.additional_properties = d
        return template

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
