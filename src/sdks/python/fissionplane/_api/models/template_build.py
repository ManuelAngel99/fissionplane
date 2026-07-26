from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..models.template_build_status import TemplateBuildStatus
from ..types import UNSET, Unset

T = TypeVar("T", bound="TemplateBuild")


@_attrs_define
class TemplateBuild:
    """
    Attributes:
        build_id (str): Canonical FissionPlane resource identifier: 24 characters from the
            lowercase alphanumeric NanoID alphabet (approximately 124 bits of
            entropy). IDs owned by external systems and content digests use their
            own schemas instead.
        status (TemplateBuildStatus): `queued` and `building` are in progress; `succeeded` and
            `failed` are terminal.
        image (str): The image reference as requested.
        created_at (datetime.datetime):
        image_digest (str | Unset): Immutable lowercase SHA-256 content digest.
        alias (str | Unset): Mutable, human-readable template alias.
        artifact_id (str | Unset): Immutable lowercase SHA-256 content digest.
        error (None | str | Unset): What failed; present exactly when `status` is `failed`.
        finished_at (datetime.datetime | None | Unset):
    """

    build_id: str
    status: TemplateBuildStatus
    image: str
    created_at: datetime.datetime
    image_digest: str | Unset = UNSET
    alias: str | Unset = UNSET
    artifact_id: str | Unset = UNSET
    error: None | str | Unset = UNSET
    finished_at: datetime.datetime | None | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        build_id = self.build_id

        status = self.status.value

        image = self.image

        created_at = self.created_at.isoformat()

        image_digest = self.image_digest

        alias = self.alias

        artifact_id = self.artifact_id

        error: None | str | Unset
        if isinstance(self.error, Unset):
            error = UNSET
        else:
            error = self.error

        finished_at: None | str | Unset
        if isinstance(self.finished_at, Unset):
            finished_at = UNSET
        elif isinstance(self.finished_at, datetime.datetime):
            finished_at = self.finished_at.isoformat()
        else:
            finished_at = self.finished_at

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "build_id": build_id,
                "status": status,
                "image": image,
                "created_at": created_at,
            }
        )
        if image_digest is not UNSET:
            field_dict["image_digest"] = image_digest
        if alias is not UNSET:
            field_dict["alias"] = alias
        if artifact_id is not UNSET:
            field_dict["artifact_id"] = artifact_id
        if error is not UNSET:
            field_dict["error"] = error
        if finished_at is not UNSET:
            field_dict["finished_at"] = finished_at

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        d = dict(src_dict)
        build_id = d.pop("build_id")

        status = TemplateBuildStatus(d.pop("status"))

        image = d.pop("image")

        created_at = datetime.datetime.fromisoformat(d.pop("created_at"))

        image_digest = d.pop("image_digest", UNSET)

        alias = d.pop("alias", UNSET)

        artifact_id = d.pop("artifact_id", UNSET)

        def _parse_error(data: object) -> None | str | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            return cast(None | str | Unset, data)

        error = _parse_error(d.pop("error", UNSET))

        def _parse_finished_at(data: object) -> datetime.datetime | None | Unset:
            if data is None:
                return data
            if isinstance(data, Unset):
                return data
            try:
                if not isinstance(data, str):
                    raise TypeError()
                finished_at_type_0 = datetime.datetime.fromisoformat(data)

                return finished_at_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(datetime.datetime | None | Unset, data)

        finished_at = _parse_finished_at(d.pop("finished_at", UNSET))

        template_build = cls(
            build_id=build_id,
            status=status,
            image=image,
            created_at=created_at,
            image_digest=image_digest,
            alias=alias,
            artifact_id=artifact_id,
            error=error,
            finished_at=finished_at,
        )

        template_build.additional_properties = d
        return template_build

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
