from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.build_step_env import BuildStepEnv


T = TypeVar("T", bound="BuildStep")


@_attrs_define
class BuildStep:
    """One recipe step, executed in order inside the build VM.

    Attributes:
        command (str): The command the step runs.
        env (BuildStepEnv | Unset): Environment for this step only.
    """

    command: str
    env: BuildStepEnv | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        command = self.command

        env: dict[str, Any] | Unset = UNSET
        if not isinstance(self.env, Unset):
            env = self.env.to_dict()

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "command": command,
            }
        )
        if env is not UNSET:
            field_dict["env"] = env

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.build_step_env import BuildStepEnv

        d = dict(src_dict)
        command = d.pop("command")

        _env = d.pop("env", UNSET)
        env: BuildStepEnv | Unset
        if isinstance(_env, Unset):
            env = UNSET
        else:
            env = BuildStepEnv.from_dict(_env)

        build_step = cls(
            command=command,
            env=env,
        )

        build_step.additional_properties = d
        return build_step

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
