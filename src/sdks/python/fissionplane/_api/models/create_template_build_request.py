from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.build_step import BuildStep
    from ..models.resources import Resources


T = TypeVar("T", bound="CreateTemplateBuildRequest")


@_attrs_define
class CreateTemplateBuildRequest:
    """
    Attributes:
        image (str): OCI image reference. A tag is resolved to an immutable
            digest when the build starts and never consulted again.
        alias (str | Unset): Mutable, human-readable template alias.
        steps (list[BuildStep] | Unset):
        start_command (str | Unset): Command started at boot, before the warm snapshot is captured.
        ready_command (str | Unset): Readiness probe the warm-up waits for before capture. The
            captured memory image contains the environment already past
            this point, which is what a resume restores.
        resources (Resources | Unset): The compute shape, set by the template artifact.
    """

    image: str
    alias: str | Unset = UNSET
    steps: list[BuildStep] | Unset = UNSET
    start_command: str | Unset = UNSET
    ready_command: str | Unset = UNSET
    resources: Resources | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        image = self.image

        alias = self.alias

        steps: list[dict[str, Any]] | Unset = UNSET
        if not isinstance(self.steps, Unset):
            steps = []
            for steps_item_data in self.steps:
                steps_item = steps_item_data.to_dict()
                steps.append(steps_item)

        start_command = self.start_command

        ready_command = self.ready_command

        resources: dict[str, Any] | Unset = UNSET
        if not isinstance(self.resources, Unset):
            resources = self.resources.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "image": image,
            }
        )
        if alias is not UNSET:
            field_dict["alias"] = alias
        if steps is not UNSET:
            field_dict["steps"] = steps
        if start_command is not UNSET:
            field_dict["start_command"] = start_command
        if ready_command is not UNSET:
            field_dict["ready_command"] = ready_command
        if resources is not UNSET:
            field_dict["resources"] = resources

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.build_step import BuildStep
        from ..models.resources import Resources

        d = dict(src_dict)
        image = d.pop("image")

        alias = d.pop("alias", UNSET)

        _steps = d.pop("steps", UNSET)
        steps: list[BuildStep] | Unset = UNSET
        if _steps is not UNSET:
            steps = []
            for steps_item_data in _steps:
                steps_item = BuildStep.from_dict(steps_item_data)

                steps.append(steps_item)

        start_command = d.pop("start_command", UNSET)

        ready_command = d.pop("ready_command", UNSET)

        _resources = d.pop("resources", UNSET)
        resources: Resources | Unset
        if isinstance(_resources, Unset):
            resources = UNSET
        else:
            resources = Resources.from_dict(_resources)

        create_template_build_request = cls(
            image=image,
            alias=alias,
            steps=steps,
            start_command=start_command,
            ready_command=ready_command,
            resources=resources,
        )

        create_template_build_request.additional_properties = d
        return create_template_build_request

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
